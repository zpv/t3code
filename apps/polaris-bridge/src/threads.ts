// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalJsonInEffect:off -- The bridge owns thread lifecycle.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  ProviderInstanceId,
  type ProjectId,
  type CommandId,
  type MessageId,
  type ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationProjectShell,
  type ServerConfig,
} from "@t3tools/contracts";
import type { Account } from "./accounts.ts";
import { chooseAccount } from "./accounts.ts";
import { effortOption, resolveModel } from "./logic.ts";
import { eventFacts } from "./events.ts";
import { Refusal, type Client } from "./t3Client.ts";
import type { ConfigFile } from "./config.ts";
import type { State, Entry } from "./state.ts";
import { pendingRequest } from "./logic.ts";

export function turnState(p: OrchestrationV2ThreadProjection) {
  if (pendingRequest(p)) return "waiting";
  const run = p.runs.at(-1);
  if (!run) return "idle";
  if (["failed"].includes(run.status)) return "failed";
  if (["completed", "interrupted", "cancelled", "rolled_back"].includes(run.status)) return "idle";
  return "working";
}
export function effort(p: OrchestrationV2ThreadProjection) {
  return (
    p.thread.modelSelection.options?.find((o) => /effort|reasoning/i.test(o.id))?.value ?? null
  );
}
export function nativeSession(p: OrchestrationV2ThreadProjection) {
  const thread =
    p.providerThreads.find((t) => t.id === p.thread.activeProviderThreadId) ??
    p.providerThreads.findLast((t) => t.providerInstanceId === p.thread.providerInstanceId);
  return thread?.nativeThreadRef?.nativeId ?? null;
}

type Agent = "claude" | "codex" | "replay";
export type Create = {
  runId: string;
  agent: Agent;
  title: string;
  repoPath: string;
  projectTitle?: string;
  worktreePath?: string;
  branch?: string;
  model?: string;
  effort?: string;
  accountProfile?: string;
  initialMessage?: string;
  sessionId?: string;
  transcriptPath?: string;
  createdAt?: string;
  lastActivityAt?: string;
  settled?: boolean;
};
type ThreadContext = {
  readonly file: ConfigFile;
  readonly serverConfig: ServerConfig | undefined;
  readonly client: Client | undefined;
  readonly connected: boolean;
  shellProjects: readonly OrchestrationProjectShell[];
  state: State;
  save: () => void;
  accounts: () => Account[];
  refreshUsage: () => Promise<void>;
  projection: (id: string) => Promise<OrchestrationV2ThreadProjection>;
  requireClient: () => Client;
  commandId: () => CommandId;
  messageId: () => MessageId;
  projectId: () => ProjectId;
  threadId: (id: string) => ThreadId;
  t3: (path: string, options?: RequestInit) => Promise<unknown>;
  postPolaris: (path: string, body: object) => Promise<unknown>;
  link: (id: string) => string;
  log: (text: string) => void;
  flush: (
    id: string,
    p: OrchestrationV2ThreadProjection,
    facts?: OrchestrationV2ThreadProjection,
  ) => Promise<void>;
  watched: Map<string, AbortController>;
  touched: Map<string, number>;
};
export function createThreadService(ctx: ThreadContext) {
  const {
    state,
    save,
    accounts,
    refreshUsage,
    projection,
    requireClient,
    commandId,
    messageId,
    projectId,
    threadId,
    t3,
    postPolaris,
    link,
    log,
    flush,
    watched,
    touched,
  } = ctx;
  const projectsInFlight = new Map<string, Promise<ProjectId>>();
  async function getProject(repoPath: string, title?: string) {
    const real = await NodeFSP.realpath(repoPath);
    const pending = projectsInFlight.get(real);
    if (pending) return pending;
    const operation = getProjectForPath(real, title);
    projectsInFlight.set(real, operation);
    try {
      return await operation;
    } finally {
      projectsInFlight.delete(real);
    }
  }
  async function getProjectForPath(real: string, title?: string) {
    const snapshot = (await t3("/api/orchestration/shell")) as {
      projects: OrchestrationProjectShell[];
    };
    ctx.shellProjects = snapshot.projects;
    for (const project of ctx.shellProjects) {
      try {
        if ((await NodeFSP.realpath(project.workspaceRoot)) === real) return project.id;
      } catch {}
    }
    const id = projectId();
    await t3("/api/projects/mutate", {
      method: "POST",
      body: JSON.stringify({
        type: "project.create",
        commandId: NodeCrypto.randomUUID(),
        projectId: id,
        title: title || NodePath.basename(real),
        workspaceRoot: real,
      }),
    });
    const shell = (await t3("/api/orchestration/shell")) as {
      projects: OrchestrationProjectShell[];
    };
    ctx.shellProjects = shell.projects;
    return id;
  }
  function modelSelection(input: Create) {
    const config = ctx.serverConfig;
    if (!config) throw new Error("T3 is disconnected");
    const selected = chooseAccount(
      accounts(),
      input.agent,
      input.accountProfile,
      ctx.file.accounts?.autoSwitch === true,
      ctx.file.accounts?.switchAtPercent ?? 97,
    );
    if (!selected) throw new Refusal(`Account unavailable: ${input.accountProfile ?? input.agent}`);
    const instance = selected.id;
    const provider = config.providers.find((p) => p.instanceId === instance);
    if (!provider) throw new Error(`Unknown provider instance ${instance}`);
    const defaults = input.agent === "replay" ? undefined : ctx.file.defaults?.[input.agent];
    const requested = input.model || defaults?.model;
    const model =
      (requested ? resolveModel(provider.models, requested) : undefined) ||
      provider.models.find((m) => m.isDefault)?.slug ||
      provider.models[0]?.slug;
    if (!model) throw new Error(`No model available for ${instance}`);
    const option = effortOption(
      provider.driver,
      input.effort ?? defaults?.effort,
      provider.models.find((m) => m.slug === model)?.capabilities?.optionDescriptors ?? [],
    );
    return {
      instanceId: ProviderInstanceId.make(instance),
      model,
      ...(option ? { options: [option] } : {}),
    };
  }
  async function finishCreation(id: string, entry: Entry) {
    if (entry.pendingCreation === "import") {
      const p = await projection(id);
      for (const message of p.messages) {
        if (message.role === "user") {
          const eventId = `t3:${id}:message:${message.id}`;
          if (!entry.events.includes(eventId)) entry.events.push(eventId);
        }
      }
    }
    delete entry.pendingCreation;
    save();
  }
  async function createOnce(input: Create, importing: boolean) {
    if (
      !input.runId ||
      !input.repoPath ||
      !input.title ||
      ![
        "claude",
        "codex",
        ...(process.env.POLARIS_T3_BRIDGE_ALLOW_REPLAY === "1" ? ["replay"] : []),
      ].includes(input.agent)
    )
      throw new Error("runId, agent, title and repoPath are required");
    const id = `polaris-${input.runId}`;
    let existing = state.threads[id];
    if (existing?.pendingCreation) {
      const shell = (await t3("/api/orchestration/shell")) as {
        threads: OrchestrationV2ThreadShell[];
        archivedThreads: OrchestrationV2ThreadShell[];
      };
      if ([...shell.threads, ...shell.archivedThreads].some((thread) => thread.id === id))
        await finishCreation(id, existing);
      else {
        delete state.threads[id];
        save();
        existing = undefined;
      }
    }
    if (existing)
      return {
        code: 200,
        body: {
          threadId: id,
          environmentId: ctx.serverConfig?.environment.environmentId,
          link: link(id),
          ...(importing
            ? { created: false, messageCount: (await projection(id)).messages.length }
            : {}),
          ...(existing.modelFallback ? { modelFallback: existing.modelFallback } : {}),
        },
      };
    await refreshUsage();
    const project = await getProject(input.repoPath, input.projectTitle);
    const selection = modelSelection(input);
    const modelFallback =
      input.model &&
      selection.model !== input.model &&
      !resolveModel(
        ctx.serverConfig?.providers.find((p) => p.instanceId === selection.instanceId)?.models ??
          [],
        input.model,
      )
        ? { requested: input.model, used: selection.model }
        : undefined;
    const entry: Entry = {
      runId: input.runId,
      events: [],
      dispatched: [],
      outbox: [],
      pendingCreation: importing ? "import" : "create",
      ...(input.accountProfile ? { accountChangedAt: Date.now() } : {}),
      ...(modelFallback ? { modelFallback } : {}),
    };
    state.threads[id] = entry;
    save();
    if (importing) {
      if (!input.sessionId || input.agent === "replay")
        throw new Error("sessionId and supported agent are required");
      const response = (await t3("/api/polaris/import-session", {
        method: "POST",
        body: JSON.stringify({
          threadId: id,
          driver: input.agent === "claude" ? "claudeAgent" : "codex",
          instanceId: selection.instanceId,
          sessionId: input.sessionId,
          transcriptPath: input.transcriptPath,
          projectId: project,
          title: input.title,
          worktreePath: input.worktreePath,
          branch: input.branch,
          modelSelection: selection,
          runtimeMode: ctx.file.defaults?.runtimeMode ?? "full-access",
          createdAt: input.createdAt,
          lastActivityAt: input.lastActivityAt,
          settled: input.settled,
        }),
      })) as { created: boolean; messageCount: number };
      await finishCreation(id, entry);
      watch(id);
      return {
        code: 200,
        body: {
          threadId: id,
          environmentId: ctx.serverConfig?.environment.environmentId,
          link: link(id),
          ...response,
          ...(modelFallback ? { modelFallback } : {}),
        },
      };
    }
    const mid = input.initialMessage ? messageId() : undefined;
    if (mid) {
      entry.dispatched.push(mid);
      save();
    }
    await Effect.runPromise(
      requireClient()["orchestration.launchThread"]({
        commandId: commandId(),
        threadId: threadId(id),
        projectId: project,
        title: input.title,
        modelSelection: selection,
        runtimeMode: ctx.file.defaults?.runtimeMode ?? "full-access",
        interactionMode: "default",
        workspaceStrategy: input.worktreePath
          ? {
              type: "existing_worktree",
              worktreePath: input.worktreePath,
              ...(input.branch ? { branch: input.branch } : {}),
            }
          : { type: "root", ...(input.branch ? { branch: input.branch } : {}) },
        ...(mid
          ? { initialMessage: { messageId: mid, text: input.initialMessage!, attachments: [] } }
          : {}),
      }),
    );
    await finishCreation(id, entry);
    watch(id);
    return {
      code: 201,
      body: {
        threadId: id,
        environmentId: ctx.serverConfig?.environment.environmentId,
        link: link(id),
        ...(modelFallback ? { modelFallback } : {}),
      },
    };
  }
  const creations = new Map<string, ReturnType<typeof createOnce>>();
  async function create(input: Create, importing: boolean) {
    const inFlight = creations.get(input.runId);
    if (inFlight) {
      const result = await inFlight;
      return {
        ...result,
        code: 200,
        body: importing ? { ...result.body, created: false } : result.body,
      };
    }
    const operation = createOnce(input, importing);
    creations.set(input.runId, operation);
    try {
      return await operation;
    } finally {
      creations.delete(input.runId);
    }
  }
  async function stop(id: string) {
    const p = await projection(id),
      c = requireClient();
    for (const run of p.runs.filter((r) =>
      ["preparing", "starting", "running", "waiting"].includes(r.status),
    ))
      await Effect.runPromise(
        c["orchestration.dispatchCommand"]({
          type: "run.interrupt",
          commandId: commandId(),
          threadId: threadId(id),
          runId: run.id,
        }),
      );
    for (const session of p.providerSessions.filter(
      (session) => !["stopped", "error"].includes(session.status),
    ))
      await Effect.runPromise(
        c["orchestration.dispatchCommand"]({
          type: "provider-session.detach",
          commandId: commandId(),
          threadId: threadId(id),
          providerSessionId: session.id,
        }),
      );
    return { ok: true };
  }
  function watch(id: string) {
    touched.set(id, Date.now());
    if (watched.has(id) || !ctx.client || !state.threads[id]) return;
    const controller = new AbortController();
    watched.set(id, controller);
    const c = ctx.client,
      entry = state.threads[id];
    void (async () => {
      try {
        const first = await projection(id);
        if (entry.cursor !== undefined)
          await flush(id, first, { ...first, messages: [], runs: [], runtimeRequests: [] });
        await Effect.runPromise(
          c["orchestration.subscribeThread"]({
            threadId: threadId(id),
            ...(entry.cursor === undefined ? {} : { afterSequence: entry.cursor }),
          }).pipe(
            Stream.runForEach((item) =>
              Effect.promise(async () => {
                if (item.kind === "synchronized") return;
                const p = item.kind === "snapshot" ? item.projection : await projection(id);
                const facts =
                  item.kind === "event"
                    ? eventFacts(p, item.event)
                    : item.kind === "snapshot"
                      ? p
                      : { ...p, messages: [], runs: [], runtimeRequests: [] };
                await flush(id, p, facts);
                if (item.kind === "snapshot") entry.cursor = item.snapshotSequence;
                else entry.cursor = item.sequence;
                save();
              }),
            ),
          ),
          { signal: controller.signal },
        );
      } catch (error) {
        if (!controller.signal.aborted) log(`thread stream ${id}: ${String(error)}`);
      } finally {
        if (watched.get(id) === controller) watched.delete(id);
        if (!controller.signal.aborted && ctx.connected) setTimeout(() => watch(id), 1000);
      }
    })();
  }
  async function handleShell(thread: OrchestrationV2ThreadShell) {
    const id = thread.id;
    if (!state.threads[id]) {
      if (thread.lineage.parentThreadId || thread.lineage.sideChat) return;
      const provider = ctx.serverConfig?.providers.find(
        (p) => p.instanceId === thread.providerInstanceId,
      );
      if (!provider || !["claudeAgent", "codex"].includes(provider.driver)) return;
      const project = ctx.shellProjects.find((p) => p.id === thread.projectId);
      if (!project) return;
      const result = await postPolaris("/v0/t3/runs/adopt", {
        threadId: id,
        environmentId: ctx.serverConfig?.environment.environmentId,
        link: link(id),
        agent: provider.driver === "claudeAgent" ? "claude" : "codex",
        title: thread.title,
        repoPath: project.workspaceRoot,
        worktreePath: thread.worktreePath,
        branch: thread.branch,
        model: thread.modelSelection.model,
        effort:
          thread.modelSelection.options?.find((o) => /effort|reasoning/i.test(o.id))?.value ?? null,
        createdAt: thread.createdAt,
      });
      if (
        !result ||
        typeof result !== "object" ||
        !("run" in result) ||
        typeof result.run !== "object" ||
        !result.run ||
        !("id" in result.run) ||
        typeof result.run.id !== "string"
      )
        return;
      if (!state.threads[id]) {
        state.threads[id] = { runId: result.run.id, events: [], dispatched: [], outbox: [] };
        save();
      }
    }
    const entry = state.threads[id]!;
    if (!creations.has(entry.runId)) {
      if (entry.pendingCreation) await finishCreation(id, entry);
      watch(id);
    }
  }

  return { create, stop, watch, handleShell };
}
