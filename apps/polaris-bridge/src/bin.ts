// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off globalJsonInEffect:off globalRandom:off extendsNativeError:off -- This process owns its HTTP and reconnect lifecycle.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
  type ServerConfig,
  type OrchestrationV2ThreadShell,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ShellSnapshot,
  type ChatAttachment,
} from "@t3tools/contracts";
import {
  deriveEvents,
  eventFacts,
  effortOption,
  instanceFor,
  pendingRequest,
  renderSnapshot,
  type Event,
} from "./logic.ts";
import { interpretInput } from "./input.ts";

type Agent = "claude" | "codex" | "replay";
type Create = {
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
type ConfigFile = {
  T3_ORIGIN?: string;
  T3_TOKEN?: string;
  POLARIS_SERVER?: string;
  POLARIS_T3_BRIDGE_PORT?: string | number;
  POLARIS_T3_BRIDGE_TOKEN?: string;
  POLARIS_T3_BRIDGE_STATE?: string;
  instances?: Record<string, { default: string; profiles: Record<string, string> }>;
  defaults?: {
    claude?: { model?: string | null; effort?: string | null };
    codex?: { model?: string | null; effort?: string | null };
    runtimeMode?: "full-access" | "approval-required";
    phoneNotifications?: boolean;
  };
};
const configPath =
  process.env.POLARIS_T3_BRIDGE_CONFIG ??
  NodePath.join(NodeOS.homedir(), ".polaris/t3-bridge.json");
const file: ConfigFile = NodeFS.existsSync(configPath)
  ? JSON.parse(NodeFS.readFileSync(configPath, "utf8"))
  : {};
const origin = (process.env.T3_ORIGIN ?? file.T3_ORIGIN ?? "http://127.0.0.1:3773").replace(
  /\/$/,
  "",
);
const token = process.env.T3_TOKEN ?? file.T3_TOKEN;
if (!token) throw new Error("T3_TOKEN is required");
const polaris = (
  process.env.POLARIS_SERVER ??
  file.POLARIS_SERVER ??
  "http://127.0.0.1:43117"
).replace(/\/$/, "");
const bridgeToken = process.env.POLARIS_T3_BRIDGE_TOKEN ?? file.POLARIS_T3_BRIDGE_TOKEN;
const statePath =
  process.env.POLARIS_T3_BRIDGE_STATE ??
  file.POLARIS_T3_BRIDGE_STATE ??
  NodePath.join(NodeOS.homedir(), ".polaris/t3-bridge-state.json");
const port = Number(process.env.POLARIS_T3_BRIDGE_PORT ?? file.POLARIS_T3_BRIDGE_PORT ?? 43118);
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
};
type Entry = {
  runId: string;
  events: string[];
  dispatched: string[];
  cursor?: number;
  state?: string;
  outbox: Event[];
  pendingCreation?: "create" | "import";
};
type State = { threads: Record<string, Entry>; shellCursor?: number };
const state: State = NodeFS.existsSync(statePath)
  ? JSON.parse(NodeFS.readFileSync(statePath, "utf8"))
  : { threads: {} };
function save() {
  NodeFS.mkdirSync(NodePath.dirname(statePath), { recursive: true });
  const temp = `${statePath}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  NodeFS.renameSync(temp, statePath);
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const log = (s: string) => console.error(`[polaris-bridge] ${s.slice(0, 300)}`);
class HttpFailure extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
async function t3(pathname: string, options: RequestInit = {}) {
  const res = await fetch(origin + pathname, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!res.ok)
    throw new HttpFailure(res.status, `T3 ${pathname}: ${res.status} ${await res.text()}`);
  return res.json();
}
async function postPolaris(pathname: string, body: object): Promise<unknown> {
  let backoff = 250;
  for (;;) {
    try {
      const res = await fetch(polaris + pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return await res.json();
      if (res.status < 500) {
        log(`polaris ${pathname}: ${res.status}, dropped`);
        return null;
      }
      log(`polaris ${pathname}: ${res.status}, retrying`);
    } catch (error) {
      log(`polaris ${pathname}: ${String(error)}, retrying`);
    }
    await delay(backoff + (Math.random() * backoff) / 4);
    backoff = Math.min(backoff * 2, 30_000);
  }
}
const makeClient = () => RpcClient.make(WsRpcGroup);
type Client = Effect.Success<ReturnType<typeof makeClient>>;
let client: Client | undefined;
let serverConfig: ServerConfig | undefined;
let shellProjects: readonly OrchestrationProjectShell[] = [];
let connected = false;
const watched = new Map<string, AbortController>();
const touched = new Map<string, number>();
function requireClient() {
  if (!client || !serverConfig) throw new Error("T3 is disconnected");
  return client;
}
const projectId = () => ProjectId.make(NodeCrypto.randomUUID());
const commandId = () => CommandId.make(NodeCrypto.randomUUID());
const threadId = (id: string) => ThreadId.make(id);
const messageId = () => MessageId.make(NodeCrypto.randomUUID());
const link = (id: string) =>
  `${origin}/threads/${encodeURIComponent(serverConfig?.environment.environmentId ?? "")}/${encodeURIComponent(id)}`;
async function projection(id: string) {
  return Effect.runPromise(
    requireClient()["orchestration.getThreadProjection"]({ threadId: threadId(id) }),
  );
}
function turnState(p: OrchestrationV2ThreadProjection) {
  if (pendingRequest(p)) return "waiting";
  const run = p.runs.at(-1);
  if (!run) return "idle";
  if (["failed"].includes(run.status)) return "failed";
  if (["completed", "interrupted", "cancelled", "rolled_back"].includes(run.status)) return "idle";
  return "working";
}
function effort(p: OrchestrationV2ThreadProjection) {
  return (
    p.thread.modelSelection.options?.find((o) => /effort|reasoning/i.test(o.id))?.value ?? null
  );
}
function nativeSession(p: OrchestrationV2ThreadProjection) {
  const thread =
    p.providerThreads.find((t) => t.id === p.thread.activeProviderThreadId) ??
    p.providerThreads.findLast((t) => t.providerInstanceId === p.thread.providerInstanceId);
  return thread?.nativeThreadRef?.nativeId ?? null;
}
const flushes = new Map<string, Promise<void>>();
function flush(id: string, p: OrchestrationV2ThreadProjection, facts = p): Promise<void> {
  const result = (flushes.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(() => flushNow(id, p, facts));
  flushes.set(id, result);
  void result
    .finally(() => {
      if (flushes.get(id) === result) flushes.delete(id);
    })
    .catch(() => {});
  return result;
}
async function flushNow(
  id: string,
  p: OrchestrationV2ThreadProjection,
  facts: OrchestrationV2ThreadProjection,
) {
  const entry = state.threads[id];
  if (!entry) return;
  for (const event of deriveEvents(facts, entry)) {
    entry.events.push(event.eventId);
    entry.outbox.push(event);
  }
  save();
  while (entry.outbox.length) {
    const event = entry.outbox[0]!;
    log(
      `event ${entry.runId} ${event.type} ${String(event.payload.text ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 80)}`,
    );
    const result = await postPolaris(`/v0/runs/${encodeURIComponent(entry.runId)}/events`, event);
    if (
      result &&
      file.defaults?.phoneNotifications !== false &&
      ["assistant.completed", "claude.ask_user_question", "claude.notification"].includes(
        event.type,
      )
    )
      await postPolaris("/v0/notifications/phone", {
        kind: event.type === "assistant.completed" ? "done" : "input-needed",
        body: String(event.payload.text ?? ""),
        runId: entry.runId,
        source: "t3-bridge",
      });
    entry.outbox.shift();
    save();
  }
  const current = {
    turnState: turnState(p),
    model: p.thread.modelSelection.model,
    effort: effort(p),
    title: p.thread.title,
    nativeSessionId: nativeSession(p),
    archived: p.thread.archivedAt !== null,
    deleted: p.thread.deletedAt !== null,
  };
  const serialized = JSON.stringify(current);
  if (serialized !== entry.state) {
    await postPolaris(`/v0/runs/${encodeURIComponent(entry.runId)}/t3/state`, current);
    entry.state = serialized;
    save();
  }
}
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
  shellProjects = snapshot.projects;
  for (const project of shellProjects) {
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
  const shell = (await t3("/api/orchestration/shell")) as { projects: OrchestrationProjectShell[] };
  shellProjects = shell.projects;
  return id;
}
function modelSelection(input: Create) {
  const config = serverConfig;
  if (!config) throw new Error("T3 is disconnected");
  const instance = instanceFor(input.agent, input.accountProfile, file.instances ?? {}, log);
  const provider = config.providers.find((p) => p.instanceId === instance);
  if (!provider) throw new Error(`Unknown provider instance ${instance}`);
  const defaults = input.agent === "replay" ? undefined : file.defaults?.[input.agent];
  const model =
    input.model ||
    defaults?.model ||
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
        environmentId: serverConfig?.environment.environmentId,
        link: link(id),
        ...(importing
          ? { created: false, messageCount: (await projection(id)).messages.length }
          : {}),
      },
    };
  const project = await getProject(input.repoPath, input.projectTitle);
  const selection = modelSelection(input);
  const entry: Entry = {
    runId: input.runId,
    events: [],
    dispatched: [],
    outbox: [],
    pendingCreation: importing ? "import" : "create",
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
        runtimeMode: file.defaults?.runtimeMode ?? "full-access",
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
        environmentId: serverConfig?.environment.environmentId,
        link: link(id),
        ...response,
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
      runtimeMode: file.defaults?.runtimeMode ?? "full-access",
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
      environmentId: serverConfig?.environment.environmentId,
      link: link(id),
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
async function upload(files: { path: string; name?: string }[]): Promise<ChatAttachment[]> {
  const attachments: ChatAttachment[] = [];
  for (const item of files) {
    const name = item.name ?? NodePath.basename(item.path);
    const handle = await NodeFSP.open(item.path, "r");
    const header = Buffer.alloc(12);
    let size: number;
    try {
      size = (await handle.stat()).size;
      await handle.read(header, 0, header.length, 0);
    } finally {
      await handle.close();
    }
    const signature = header.toString("hex");
    const imageMime = signature.startsWith("89504e470d0a1a0a")
      ? "image/png"
      : signature.startsWith("ffd8ff")
        ? "image/jpeg"
        : header.subarray(0, 6).toString("ascii") === "GIF87a" ||
            header.subarray(0, 6).toString("ascii") === "GIF89a"
          ? "image/gif"
          : header.subarray(0, 4).toString("ascii") === "RIFF" &&
              header.subarray(8, 12).toString("ascii") === "WEBP"
            ? "image/webp"
            : undefined;
    const type = imageMime ? "image" : "file";
    const mime =
      imageMime ??
      ({ ".pdf": "application/pdf", ".txt": "text/plain" } as Record<string, string>)[
        NodePath.extname(name).toLowerCase()
      ] ??
      "application/octet-stream";
    if (size === 0 || size > (type === "image" ? 10 : 50) * 1024 * 1024)
      throw new Refusal(`${name} is empty or exceeds the ${type === "image" ? 10 : 50} MB limit`);
    const data = await NodeFSP.readFile(item.path);
    if (data.length !== size) throw new Refusal(`${name} changed while being uploaded`);
    const minted = await Effect.runPromise(
      requireClient()["attachments.createUploadUrl"](
        type === "image"
          ? {
              type,
              name,
              mimeType: mime as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
              sizeBytes: data.length,
            }
          : { type, name, mimeType: mime, sizeBytes: data.length },
      ),
    );
    const response = await fetch(new URL(minted.relativeUrl, origin), {
      method: "POST",
      headers: { "Content-Type": mime },
      body: data,
    });
    if (!response.ok) throw new Error(`Upload ${name} failed: ${response.status}`);
    attachments.push({
      id: minted.attachmentId,
      type,
      name,
      mimeType: mime,
      sizeBytes: data.length,
    });
  }
  return attachments;
}
class Refusal extends Error {}
async function input(
  id: string,
  body: { input: string; attachments?: { path: string; name?: string }[] },
) {
  if (typeof body.input !== "string") throw new Refusal("input must be a string");
  const p = await projection(id),
    pending = pendingRequest(p);
  const action = interpretInput(body.input, pending);
  const thread = threadId(id),
    c = requireClient(),
    active = p.runs.findLast((r) =>
      ["preparing", "starting", "running", "waiting"].includes(r.status),
    );
  if (action.type === "refuse") throw new Refusal(action.reason);
  if (action.type === "interrupt") {
    if (!active) return { ok: true, delivery: "idle", messageId: null };
    await Effect.runPromise(
      c["orchestration.dispatchCommand"]({
        type: "run.interrupt",
        commandId: commandId(),
        threadId: thread,
        runId: active.id,
      }),
    );
    return { ok: true, delivery: "interrupted", messageId: null };
  }
  if (action.type === "question" && pending?.kind === "question") {
    const answer =
      action.option === null
        ? action.text
        : (pending.question.options[action.option - 1]?.value ??
          pending.question.options[action.option - 1]?.label);
    await Effect.runPromise(
      c["orchestration.dispatchCommand"]({
        type: "runtime-request.respond",
        commandId: commandId(),
        threadId: thread,
        requestId: pending.id,
        answers: { [pending.question.id]: answer },
      }),
    );
    return { ok: true, delivery: "answered", messageId: null };
  }
  if (action.type === "approval" && pending) {
    await Effect.runPromise(
      c["orchestration.dispatchCommand"]({
        type: "runtime-request.respond",
        commandId: commandId(),
        threadId: thread,
        requestId: pending.id,
        decision: action.approved ? "accept" : "decline",
      }),
    );
    return { ok: true, delivery: "answered", messageId: null };
  }
  if (action.type === "model" || action.type === "effort") {
    const current = p.thread.modelSelection;
    const provider = serverConfig?.providers.find((v) => v.instanceId === current.instanceId);
    const model = action.type === "model" ? action.value : current.model;
    const selected =
      action.type === "effort"
        ? effortOption(
            provider?.driver ?? "",
            action.value,
            provider?.models.find((m) => m.slug === model)?.capabilities?.optionDescriptors ?? [],
          )
        : undefined;
    if (action.type === "effort" && !selected)
      throw new Refusal(`Unsupported effort: ${action.value}`);
    const options =
      action.type === "effort"
        ? [...(current.options ?? []).filter((o) => o.id !== selected!.id), selected!]
        : [];
    await Effect.runPromise(
      c["orchestration.dispatchCommand"]({
        type: "thread.model-selection.set",
        commandId: commandId(),
        threadId: thread,
        modelSelection: {
          instanceId: current.instanceId,
          model,
          ...(options.length ? { options } : {}),
        },
      }),
    );
    return { ok: true, delivery: "configured", messageId: null };
  }
  if (action.type !== "message") throw new Refusal("Cannot answer this request");
  const attachments = await upload(body.attachments ?? []);
  const mid = messageId();
  const entry = state.threads[id];
  if (!entry) throw new Refusal("Thread is not mapped");
  entry.dispatched.push(mid);
  save();
  await Effect.runPromise(
    c["orchestration.dispatchCommand"]({
      type: "message.dispatch",
      commandId: commandId(),
      threadId: thread,
      messageId: mid,
      text: action.text,
      attachments,
      dispatchMode: { type: active ? "queue_after_active" : "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    }),
  );
  watch(id);
  return { ok: true, delivery: active ? "queued" : "started", messageId: mid };
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
  if (watched.has(id) || !client || !state.threads[id]) return;
  const controller = new AbortController();
  watched.set(id, controller);
  const c = client,
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
      if (!controller.signal.aborted && connected) setTimeout(() => watch(id), 1000);
    }
  })();
}
async function handleShell(thread: OrchestrationV2ThreadShell) {
  const id = thread.id;
  if (!state.threads[id]) {
    if (thread.lineage.parentThreadId || thread.lineage.sideChat) return;
    const provider = serverConfig?.providers.find(
      (p) => p.instanceId === thread.providerInstanceId,
    );
    if (!provider || !["claudeAgent", "codex"].includes(provider.driver)) return;
    const project = shellProjects.find((p) => p.id === thread.projectId);
    if (!project) return;
    const result = await postPolaris("/v0/t3/runs/adopt", {
      threadId: id,
      environmentId: serverConfig?.environment.environmentId,
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
async function route(req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  log(`${req.method} ${url.pathname}`);
  const reply = (status: number, body: object) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  if (bridgeToken && req.headers.authorization !== `Bearer ${bridgeToken}`)
    return reply(401, { error: "Unauthorized" });
  try {
    if (req.method === "GET" && url.pathname === "/v1/health")
      return reply(200, {
        ok: true,
        t3: { connected, origin, environmentId: serverConfig?.environment.environmentId ?? null },
        polaris: { server: polaris },
      });
    if (!connected) return reply(503, { error: "T3 is disconnected" });
    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const b = Buffer.from(chunk);
        size += b.length;
        if (size > 1024 * 1024) throw new Refusal("Request is too large");
        chunks.push(b);
      }
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    }
    if (req.method === "POST" && ["/v1/threads", "/v1/threads/import"].includes(url.pathname)) {
      // polarisd sends absent optional fields as empty strings or null.
      const input = Object.fromEntries(
        Object.entries(body as Record<string, unknown>).filter(
          ([, value]) => value !== "" && value !== null,
        ),
      ) as unknown as Create;
      const result = await create(input, url.pathname.endsWith("/import"));
      return reply(result.code, result.body);
    }
    const match = /^\/v1\/threads\/([^/]+)(?:\/(input|stop|snapshot))?$/.exec(url.pathname);
    if (!match) return reply(404, { error: "Not found" });
    const id = decodeURIComponent(match[1]!);
    if (!state.threads[id]) return reply(404, { error: "Thread not found" });
    if (req.method === "POST" && match[2] === "input")
      return reply(
        200,
        await input(id, body as { input: string; attachments?: { path: string; name?: string }[] }),
      );
    if (req.method === "POST" && match[2] === "stop") return reply(200, await stop(id));
    if (req.method === "GET" && match[2] === "snapshot") {
      watch(id);
      const n = Number(url.searchParams.get("lines") ?? 200);
      return reply(200, {
        output: renderSnapshot(await projection(id), Number.isSafeInteger(n) && n > 0 ? n : 200),
      });
    }
    if (req.method === "GET" && !match[2]) {
      const p = await projection(id),
        provider = serverConfig?.providers.find(
          (v) => v.instanceId === p.thread.providerInstanceId,
        ),
        pending = pendingRequest(p);
      watch(id);
      return reply(200, {
        threadId: id,
        environmentId: serverConfig?.environment.environmentId,
        link: link(id),
        title: p.thread.title,
        agent: provider?.driver === "claudeAgent" ? "claude" : provider?.driver,
        turnState: turnState(p),
        model: p.thread.modelSelection.model,
        effort: effort(p),
        worktreePath: p.thread.worktreePath,
        branch: p.thread.branch,
        nativeSessionId: nativeSession(p),
        pendingRequest: pending
          ? { id: pending.id, kind: pending.kind, text: pending.text, options: pending.options }
          : null,
      });
    }
    return reply(404, { error: "Not found" });
  } catch (error) {
    if (error instanceof Refusal || (error instanceof HttpFailure && error.status === 409))
      return reply(409, { ok: false, reason: error.message });
    log(`request failed: ${String(error)}`);
    return reply(500, { error: String(error) });
  }
}
const server = NodeHttp.createServer((req, res) => {
  void route(req, res);
});
server.listen(port, "127.0.0.1", () => log(`listening on 127.0.0.1:${port}`));
const sweep = setInterval(() => {
  for (const [id, controller] of watched)
    if ((touched.get(id) ?? 0) < Date.now() - 120_000) {
      void projection(id)
        .then((p) => {
          if (turnState(p) === "idle" || turnState(p) === "failed") controller.abort();
        })
        .catch(() => {});
    }
}, 30_000);
process.on("SIGTERM", () => {
  clearInterval(sweep);
  for (const c of watched.values()) c.abort();
  server.close();
  process.exit(0);
});
async function connect() {
  const ticket = (await t3("/api/auth/websocket-ticket", { method: "POST" })) as { ticket: string };
  const socket = Socket.layerWebSocket(
    `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(socket),
    Layer.provide(RpcSerialization.layerJson),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const c = yield* makeClient();
        client = c;
        serverConfig = yield* c["server.getConfig"]({});
        connected = true;
        log(`connected to ${origin}`);
        const cursor = state.shellCursor;
        if (cursor !== undefined) {
          const snapshot = yield* Effect.promise(
            () => t3("/api/orchestration/shell") as Promise<OrchestrationV2ShellSnapshot>,
          );
          shellProjects = snapshot.projects;
          yield* Effect.promise(() =>
            Promise.all([...snapshot.threads, ...snapshot.archivedThreads].map(handleShell)),
          );
        }
        yield* c["orchestration.subscribeShell"](
          cursor === undefined ? {} : { afterSequence: cursor },
        ).pipe(
          Stream.runForEach((item) =>
            Effect.promise(async () => {
              if (item.kind === "snapshot") {
                shellProjects = item.snapshot.projects;
                await Promise.all(
                  [...item.snapshot.threads, ...item.snapshot.archivedThreads].map(handleShell),
                );
                state.shellCursor = item.snapshot.snapshotSequence;
                save();
              } else if (item.kind === "project.updated") {
                shellProjects = [
                  ...shellProjects.filter((p) => p.id !== item.project.id),
                  item.project,
                ];
                state.shellCursor = item.sequence;
                save();
              } else if (item.kind === "project.removed") {
                shellProjects = shellProjects.filter((p) => p.id !== item.projectId);
                state.shellCursor = item.sequence;
                save();
              } else if (item.kind === "thread.updated") {
                await handleShell(item.thread);
                state.shellCursor = item.sequence;
                save();
              } else if (item.kind === "thread.removed") {
                state.shellCursor = item.sequence;
                save();
              }
            }),
          ),
        );
      }),
    ).pipe(Effect.provide(protocol)),
  );
}
let backoff = 250;
for (;;) {
  try {
    await connect();
    backoff = 250;
  } catch (error) {
    log(`connection: ${String(error)}`);
  }
  connected = false;
  client = undefined;
  for (const c of watched.values()) c.abort();
  watched.clear();
  await delay(backoff + (Math.random() * backoff) / 4);
  backoff = Math.min(backoff * 2, 30_000);
}
