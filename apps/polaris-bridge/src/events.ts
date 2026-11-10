// @effect-diagnostics globalDate:off globalJsonInEffect:off -- The bridge owns event delivery.
import * as Effect from "effect/Effect";
import {
  CommandId,
  MessageId,
  RunId,
  type ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2DomainEvent,
  type ServerConfig,
} from "@t3tools/contracts";
import type { ConfigFile } from "./config.ts";
import type { State } from "./state.ts";
import type { Client } from "./t3Client.ts";
import { chooseSwitch, type Account } from "./accounts.ts";
import { turnState, effort, nativeSession } from "./threads.ts";
import { resumeSwitch } from "./switch.ts";
import { pendingRequest, type Projection, type Event, type Marks } from "./logic.ts";

export function deriveEvents(p: Projection, marks: Marks): Event[] {
  const seen = new Set(marks.events);
  const dispatched = new Set(marks.dispatched);
  const thread = p.thread.id;
  const events: Event[] = [];
  const add = (id: string, type: string, payload: Record<string, unknown>) => {
    const eventId = `t3:${thread}:${id}`;
    if (!seen.has(eventId)) events.push({ eventId, type, source: "t3-bridge", payload });
  };
  for (const message of p.messages)
    if (message.role === "user" && message.createdBy === "user" && !dispatched.has(message.id))
      add(`message:${message.id}`, "user.prompt", {
        text: message.text,
        messageId: message.id,
        origin: "t3",
      });
  for (const run of p.runs) {
    if (run.status !== "queued" && (run.status !== "cancelled" || run.startedAt))
      add(`run:${run.id}:started`, "t3.run.started", {
        t3RunId: run.id,
        origin: marks.inputMessages?.includes(run.userMessageId) ? "polaris" : "t3",
      });
    if (!["completed", "interrupted", "failed", "cancelled"].includes(run.status)) continue;
    const last = p.messages
      .filter((message) => message.role === "assistant" && message.runId === run.id)
      .at(-1);
    if (last?.text)
      add(`run:${run.id}:terminal`, "assistant.completed", {
        text: last.text,
        t3RunId: run.id,
        status: run.status === "cancelled" ? "interrupted" : run.status,
      });
    else if (run.status === "failed") {
      const error = p.turnItems.findLast((item) => item.runId === run.id && item.type === "error");
      add(`run:${run.id}:terminal`, "t3.run.failed", {
        text: error?.type === "error" ? error.failure.message : "Run failed",
        t3RunId: run.id,
      });
    }
  }
  const pending = pendingRequest(p, marks.answers);
  if (pending) {
    const text = pending.text + pending.options.map((o, i) => `\n${i + 1}. ${o}`).join("");
    add(
      `request:${pending.id}${pending.kind === "question" ? `:${pending.index}` : ""}`,
      pending.kind === "question" ? "claude.ask_user_question" : "claude.notification",
      {
        text,
        requestId: pending.id,
        ...(pending.kind === "question"
          ? { options: pending.options, notification_type: "ask_user_question" }
          : { notification_type: "permission_prompt" }),
      },
    );
  }
  return events;
}

export function eventFacts(p: Projection, event: OrchestrationV2DomainEvent): Projection {
  const empty = { ...p, messages: [], runs: [], runtimeRequests: [] };
  switch (event.type) {
    case "message.updated":
      return { ...empty, messages: [event.payload] };
    case "run.created":
    case "run.updated":
      return {
        ...empty,
        runs: [event.payload],
        messages: p.messages.filter(
          (message) => message.role === "assistant" && message.runId === event.payload.id,
        ),
      };
    case "runtime-request.updated":
      return { ...empty, runtimeRequests: [event.payload] };
    default:
      return empty;
  }
}

type EventContext = {
  readonly file: ConfigFile;
  readonly serverConfig: ServerConfig | undefined;
  state: State;
  save: () => void;
  accounts: () => Account[];
  projection: (id: string) => Promise<OrchestrationV2ThreadProjection>;
  changeAccount: (
    id: string,
    profile: string,
    reason?: "manual" | "usage_limit",
    flushChanges?: boolean,
    resetAt?: string,
    command?: string,
    suppressEvent?: boolean,
  ) => Promise<unknown>;
  requireClient: () => Client;
  commandId: () => CommandId;
  messageId: () => MessageId;
  threadId: (id: string) => ThreadId;
  link: (id: string) => string;
  log: (text: string) => void;
  postPolaris: (path: string, body: object) => Promise<unknown>;
};
export function createEventService(ctx: EventContext) {
  const {
    state,
    save,
    accounts,
    projection,
    changeAccount,
    requireClient,
    commandId,
    messageId,
    threadId,
    link,
    log,
    postPolaris,
  } = ctx;
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
    let switched = false;
    if (entry.switching) {
      switched = await resumeSwitch(id, entry, {
        save,
        current: async () => (await projection(id)).thread.providerInstanceId,
        move: async (_from, to, command) => {
          const target = accounts().find((account) => account.id === to);
          if (!target || !target.enabled || target.signedIn === false) return false;
          await changeAccount(id, target.profile, "usage_limit", false, undefined, command, true);
          return true;
        },
        dispatch: async (intent) => {
          await Effect.runPromise(
            requireClient()["orchestration.dispatchCommand"]({
              type: "message.dispatch",
              commandId: CommandId.make(intent.messageCommandId),
              threadId: threadId(id),
              messageId: MessageId.make(intent.messageId),
              text: "Continue where you left off.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "server",
              usageLimitContinuationOfRunId: RunId.make(intent.failedRunId),
            }),
          );
        },
        post: async (event) => {
          const response = await postPolaris(
            `/v0/runs/${encodeURIComponent(entry.runId)}/events`,
            event,
          );
          if (!response) throw new Error("Switch event was not acknowledged");
        },
      });
      if (!switched) facts = p;
    }
    if (
      entry.answers &&
      !p.runtimeRequests.some(
        (request) => request.id === entry.answers?.requestId && request.status === "pending",
      )
    ) {
      delete entry.answers;
    }
    const terminal = facts.runs.find((run) => run.status === "failed");
    const limit =
      terminal &&
      p.turnItems.findLast(
        (item) =>
          item.runId === terminal.id &&
          item.type === "error" &&
          item.failure.class === "usage_limit",
      );
    if (
      terminal &&
      limit &&
      ctx.file.accounts?.autoSwitch &&
      !entry.switchRuns?.includes(terminal.id) &&
      !entry.events.includes(`t3:${id}:run:${terminal.id}:terminal`)
    ) {
      const currentAccount = accounts().find((a) => a.id === p.thread.providerInstanceId);
      if (currentAccount) {
        const target = chooseSwitch(
          accounts(),
          currentAccount,
          entry.switchAccounts ?? [],
          entry.accountChangedAt,
          Date.now(),
          ctx.file.accounts.switchAtPercent ?? 97,
        );
        entry.switchAccounts = [...new Set([...(entry.switchAccounts ?? []), currentAccount.id])];
        if (target) {
          const oldProvider = ctx.serverConfig?.providers.find(
            (provider) => provider.instanceId === currentAccount.id,
          );
          const newProvider = ctx.serverConfig?.providers.find(
            (provider) => provider.instanceId === target.id,
          );
          const resume =
            oldProvider?.driver === newProvider?.driver &&
            oldProvider?.continuation?.groupKey &&
            oldProvider.continuation.groupKey === newProvider?.continuation?.groupKey
              ? "native"
              : "handoff";
          const resetAt = limit.type === "error" ? limit.failure.resetAt : undefined;
          entry.switching = {
            from: currentAccount.id,
            to: target.id,
            failedRunId: terminal.id,
            moveCommandId: commandId(),
            messageCommandId: commandId(),
            messageId: messageId(),
            event: {
              eventId: `t3:${id}:account:usage-limit:${terminal.id}`,
              type: "t3.account.switched",
              source: "t3-bridge",
              payload: {
                text: `${currentAccount.label} hit its limit${resetAt ? ` (resets ${resetAt})` : ""}. Continuing on ${target.label}.`,
                from: currentAccount.profile,
                to: target.profile,
                reason: "usage_limit",
                resume,
                link: link(id),
              },
            },
          };
          save();
          return flushNow(id, await projection(id), facts);
        }
        entry.switchRuns = [...(entry.switchRuns ?? []), terminal.id];
        save();
      }
    }
    if (facts.runs.some((run) => run.status === "completed")) {
      delete entry.switchAccounts;
      delete entry.switchRuns;
    }
    for (const event of deriveEvents(facts, entry)) {
      if (switched && event.eventId === `t3:${id}:run:${terminal?.id}:terminal`) {
        entry.events.push(event.eventId);
        continue;
      }
      if (
        limit &&
        terminal &&
        event.eventId === `t3:${id}:run:${terminal.id}:terminal` &&
        !switched
      ) {
        const current = accounts().find((a) => a.id === p.thread.providerInstanceId);
        const resets = accounts()
          .filter((a) => a.agent === current?.agent)
          .flatMap((a) => a.usage?.windows.flatMap((w) => (w.resetsAt ? [w.resetsAt] : [])) ?? [])
          .sort();
        event.type = "t3.run.failed";
        event.payload = {
          text: `${limit.type === "error" ? limit.failure.message : "Usage limit reached"}${resets[0] ? ` (earliest reset ${resets[0]})` : ""}`,
          t3RunId: terminal.id,
        };
      }
      event.payload.link = link(id);
      entry.events.push(event.eventId);
      entry.outbox.push(event);
    }
    save();
    while (entry.outbox.length) {
      const event = entry.outbox[0]!;
      log(`event ${entry.runId} ${event.type}`);
      const result = await postPolaris(`/v0/runs/${encodeURIComponent(entry.runId)}/events`, event);
      if (!result) throw new Error("Event was not acknowledged");
      if (
        ctx.file.defaults?.phoneNotifications !== false &&
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
      link: link(id),
      ...(accounts().find((a) => a.id === p.thread.providerInstanceId)?.profile
        ? { accountProfile: accounts().find((a) => a.id === p.thread.providerInstanceId)!.profile }
        : {}),
    };
    const serialized = JSON.stringify(current);
    if (serialized !== entry.state) {
      await postPolaris(`/v0/runs/${encodeURIComponent(entry.runId)}/t3/state`, current);
      entry.state = serialized;
      save();
    }
  }
  async function refreshLinks() {
    await Promise.all(
      Object.keys(state.threads).map(async (id) => {
        try {
          await flush(id, await projection(id));
        } catch {
          log(`Could not refresh thread ${id}`);
        }
      }),
    );
  }

  return { flush, refreshLinks };
}
