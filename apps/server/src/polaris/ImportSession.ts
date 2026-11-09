// @effect-diagnostics nodeBuiltinImport:off -- Transcript discovery uses Node directory entries and bounded reads.
import {
  AuthOrchestrationOperateScope,
  ClaudeSettings,
  CodexSettings,
  EventId,
  MessageId,
  ModelSelection,
  isRuntimeModeAbove,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { authenticateMediaRequest } from "../auth/http.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import * as ServerSettings from "../serverSettings.ts";

const IMPORT_EVENT_PREFIX = "polaris-import:v1";
const Input = Schema.Struct({
  threadId: ThreadId,
  driver: Schema.Literals(["claudeAgent", "codex"]),
  instanceId: ProviderInstanceId,
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  transcriptPath: Schema.optional(Schema.String),
  projectId: ProjectId,
  title: Schema.String,
  worktreePath: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  createdAt: Schema.optional(Schema.String),
  lastActivityAt: Schema.optional(Schema.String),
  settled: Schema.optional(Schema.Boolean),
});
type Input = typeof Input.Type;
const decodeClaudeSettings = Schema.decodeOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeOption(CodexSettings);
const dateTime = (value: string) => DateTime.makeUnsafe(value);

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

// The shared parser retains 200 messages per call. Small, turn-aligned batches preserve its
// Codex duplicate handling while allowing this import to retain the most recent 399.
async function parseHistory(input: Input, transcriptPath: string, mtime: number) {
  const sentinel = "polaris-import-sentinel-5d8f9c";
  const metadata =
    input.driver === "codex"
      ? JSON.stringify({ type: "session_meta", payload: { id: input.sessionId } })
      : "";
  const synthetic =
    input.driver === "codex"
      ? JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: sentinel } })
      : JSON.stringify({
          type: "user",
          sessionId: input.sessionId,
          message: { content: sentinel },
        });
  let firstUser: AgentSessionScanner.AgentSessionThreadMessage | undefined;
  let count = 0;
  let records = 0;
  let sessionSeen = false;
  const recent: AgentSessionScanner.AgentSessionThreadMessage[] = [];
  let batch: string[] = [];
  const parseBatch = (records: ReadonlyArray<string>) =>
    AgentSessionScanner.parseAgentSessionTranscript({
      source: input.driver,
      providerInstanceId: input.instanceId,
      fallbackSessionId: input.sessionId,
      lastActiveAtMs: mtime,
      contents: [metadata, synthetic, ...records].filter(Boolean).join("\n"),
    });
  const flush = () => {
    if (batch.length === 0) return true;
    const parsed = parseBatch(batch);
    if (!parsed || parsed.providerSessionId !== input.sessionId) return false;
    let pieces = [parsed];
    if (parsed.omittedMessageCount > 0 && input.driver === "codex") {
      // Keep matching Codex user records together so the shared parser can deduplicate them.
      const groups = new Map<string, Array<{ index: number; event: boolean }>>();
      const turns = new Map<string, { indices: number[]; texts: Set<string> }>();
      for (let index = 0; index < batch.length; index++) {
        let record: {
          type?: string;
          payload?: {
            type?: string;
            role?: string;
            internal_chat_message_metadata_passthrough?: { turn_id?: unknown };
          };
        };
        try {
          record = JSON.parse(batch[index]!);
        } catch {
          continue;
        }
        const event = record.type === "event_msg" && record.payload?.type === "user_message";
        const response =
          record.type === "response_item" &&
          record.payload?.type === "message" &&
          record.payload?.role === "user";
        if (!event && !response) continue;
        const text = parseBatch([batch[index]!])?.messages[1]?.text.trim();
        if (!text) continue;
        const group = groups.get(text) ?? [];
        group.push({ index, event });
        groups.set(text, group);
        const turnId = record.payload?.internal_chat_message_metadata_passthrough?.turn_id;
        if (response && typeof turnId === "string" && turnId.trim()) {
          const turn = turns.get(turnId) ?? { indices: [], texts: new Set<string>() };
          turn.indices.push(index);
          turn.texts.add(text);
          turns.set(turnId, turn);
        }
      }
      const skipped = new Set<number>();
      for (const turn of turns.values()) {
        if ([...turn.texts].some((text) => groups.get(text)?.some((item) => item.event))) {
          for (const index of turn.indices) skipped.add(index);
        }
      }
      const changes = new Array<number>(batch.length + 1).fill(0);
      const keepTogether = (first: number, last: number) => {
        if (first === last) return;
        if (last - first >= 200) {
          const span = parseBatch(
            batch.slice(first, last + 1).filter((_line, offset) => !skipped.has(first + offset)),
          );
          if (span && span.messages.length + span.omittedMessageCount - 1 > 200) return;
        }
        changes[first] = changes[first]! + 1;
        changes[last] = changes[last]! - 1;
      };
      for (const group of groups.values()) {
        let previousEvent: number | undefined;
        let pending: number | undefined;
        for (const item of group) {
          if (skipped.has(item.index)) continue;
          if (item.event) {
            if (pending !== undefined) keepTogether(pending, item.index);
            pending = undefined;
            previousEvent = item.index;
          } else if (previousEvent === undefined) {
            pending = item.index;
          } else {
            keepTogether(previousEvent, item.index);
          }
        }
      }
      pieces = [];
      let start = 0;
      let active = 0;
      for (let index = 0; index < batch.length; index++) {
        active += changes[index]!;
        if (active !== 0 || (index - start + 1 < 100 && index !== batch.length - 1)) continue;
        const piece = parseBatch(
          batch.slice(start, index + 1).filter((_line, offset) => !skipped.has(start + offset)),
        );
        if (!piece || piece.omittedMessageCount !== 0) return false;
        pieces.push(piece);
        start = index + 1;
      }
    } else if (parsed.omittedMessageCount !== 0) return false;
    for (const piece of pieces) {
      for (const message of piece.messages.slice(1)) {
        if (!firstUser && message.role === "user") firstUser = message;
        count++;
        recent.push(message);
        if (recent.length > 400) recent.shift();
      }
    }
    batch = [];
    return true;
  };
  const source = NodeFS.createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = NodeReadline.createInterface({ input: source, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (++records > 100_000) return null;
      batch.push(line);
      let record: {
        type?: string;
        sessionId?: string;
        payload?: { id?: string; session_id?: string; type?: string; role?: string };
      };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const id =
        input.driver === "codex" && record.type === "session_meta"
          ? (record.payload?.id ?? record.payload?.session_id)
          : input.driver === "claudeAgent"
            ? record.sessionId
            : undefined;
      if (typeof id === "string" && id.trim()) {
        if (id !== input.sessionId) return null;
        sessionSeen = true;
      }
      const boundary =
        input.driver === "codex"
          ? record.type === "response_item" &&
            record.payload?.type === "message" &&
            record.payload.role === "assistant"
          : record.type === "assistant";
      if (batch.length >= 100 && (input.driver === "claudeAgent" || boundary) && !flush())
        return null;
    }
    if (!flush() || !firstUser || (input.driver === "codex" && !sessionSeen)) return null;
    const messages =
      count <= 400 || recent.includes(firstUser) ? recent : [firstUser, ...recent.slice(-399)];
    return { messages, omitted: count - messages.length };
  } finally {
    lines.close();
    source.destroy();
  }
}

async function findTranscript(
  directory: string,
  sessionId: string,
  driver: Input["driver"],
): Promise<string | null> {
  let entries;
  try {
    entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const target = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findTranscript(target, sessionId, driver);
      if (found) return found;
    } else if (
      entry.isFile() &&
      (driver === "claudeAgent"
        ? entry.name === `${sessionId}.jsonl`
        : entry.name.endsWith(`${sessionId}.jsonl`) ||
          (entry.name.includes(`${sessionId}_`) && entry.name.endsWith(".jsonl")))
    )
      return target;
  }
  return null;
}

class ImportError extends Schema.TaggedError<ImportError>()("PolarisImportError", {
  status: Schema.Number,
  message: Schema.String,
}) {}

export class ImportSession extends Context.Service<
  ImportSession,
  {
    readonly run: (
      input: Input,
    ) => Effect.Effect<{ threadId: ThreadId; created: boolean; messageCount: number }, ImportError>;
  }
>()("t3/polaris/ImportSession") {}

const make = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const run = Effect.fn("PolarisImportSession.run")(function* (input: Input) {
    if (
      settings.managedPolicy?.limits?.maxRuntimeMode !== undefined &&
      isRuntimeModeAbove(input.runtimeMode, settings.managedPolicy.limits.maxRuntimeMode)
    )
      return yield* new ImportError({
        status: 403,
        message: "Runtime mode exceeds the managed policy limit",
      });
    if (input.modelSelection.instanceId !== input.instanceId)
      return yield* new ImportError({
        status: 400,
        message: "Model instance does not match instanceId",
      });
    const existing = yield* orchestrator
      .getThreadRecords(input.threadId, ["messages", "providerThreads"])
      .pipe(Effect.option);
    if (Option.isSome(existing)) {
      const owned = existing.value.providerThreads.some(
        (provider) =>
          provider.driver === input.driver &&
          provider.providerInstanceId === input.instanceId &&
          provider.nativeThreadRef?.nativeId === input.sessionId,
      );
      if (!owned || existing.value.thread.projectId !== input.projectId)
        return yield* new ImportError({
          status: 409,
          message: "Thread belongs to another session",
        });
      return {
        threadId: input.threadId,
        created: false,
        messageCount: existing.value.messages.length,
      };
    }
    const project = yield* projects
      .getById(input.projectId)
      .pipe(
        Effect.mapError(() => new ImportError({ status: 500, message: "Could not read project" })),
      );
    if (Option.isNone(project))
      return yield* new ImportError({ status: 400, message: "Project not found" });
    const serverSettings = yield* settings.getSettings.pipe(
      Effect.mapError(() => new ImportError({ status: 500, message: "Could not read settings" })),
    );
    const instance = serverSettings.providerInstances[input.instanceId];
    if (instance && instance.driver !== input.driver)
      return yield* new ImportError({
        status: 400,
        message: "Provider driver does not match instance",
      });
    if (!instance && input.instanceId !== input.driver)
      return yield* new ImportError({ status: 400, message: "Provider instance not found" });
    let transcriptPath = input.transcriptPath;
    if (!transcriptPath) {
      const envName = input.driver === "claudeAgent" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      const configuredHome = instance?.environment?.findLast(
        (item) => item.name === envName,
      )?.value;
      const envHome = typeof configuredHome === "string" ? configuredHome : environment[envName];
      let base: string;
      if (input.driver === "claudeAgent") {
        const config = decodeClaudeSettings(instance?.config ?? {});
        if (Option.isNone(config))
          return yield* new ImportError({ status: 400, message: "Invalid provider settings" });
        base = config.value.homePath || envHome || path.join(home, ".claude");
        base = path.resolve(expandHomePath(base, home));
        base = path.join(base, "projects");
      } else {
        const config = decodeCodexSettings(instance?.config ?? {});
        if (Option.isNone(config))
          return yield* new ImportError({ status: 400, message: "Invalid provider settings" });
        const configured =
          !config.value.homePath && !config.value.shadowHomePath && envHome
            ? { ...config.value, homePath: envHome }
            : config.value;
        const layout = yield* resolveCodexHomeLayout(configured).pipe(
          Effect.provideService(Path.Path, path),
        );
        base = path.join(layout.sharedHomePath, "sessions");
      }
      transcriptPath =
        (yield* Effect.promise(() => findTranscript(base, input.sessionId, input.driver))) ??
        undefined;
    }
    if (!transcriptPath || !path.isAbsolute(transcriptPath))
      return yield* new ImportError({ status: 409, message: "Session transcript not found" });
    const file = yield* Effect.tryPromise({
      try: async () => {
        const stat = await NodeFSP.stat(transcriptPath!);
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024 * 1024)
          throw new Error("Invalid transcript");
        return stat;
      },
      catch: () =>
        new ImportError({ status: 409, message: "Session transcript not found or unreadable" }),
    });
    const history = yield* Effect.tryPromise({
      try: () => parseHistory(input, transcriptPath!, file.mtimeMs),
      catch: () => new ImportError({ status: 409, message: "Session transcript unreadable" }),
    });
    if (!history)
      return yield* new ImportError({
        status: 409,
        message: "Session transcript is invalid or does not match sessionId",
      });
    const created = DateTime.make(
      input.createdAt ?? history.messages[0]?.createdAt ?? file.mtimeMs,
    );
    const updated = DateTime.make(input.lastActivityAt ?? file.mtimeMs);
    if (Option.isNone(created) || Option.isNone(updated))
      return yield* new ImportError({ status: 400, message: "Invalid timestamp" });
    const driver = ProviderDriverKind.make(input.driver);
    const providerThreadId = ids.derive.providerThread({
      driver,
      providerInstanceId: input.instanceId,
      nativeThreadId: input.sessionId,
    });
    const appThread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: input.threadId,
      projectId: input.projectId,
      title: input.title,
      providerInstanceId: input.instanceId,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      branch: input.branch ?? null,
      worktreePath: input.worktreePath ?? null,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: providerThreadId,
      historyOrigin: "native",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
      forkedFrom: null,
      createdAt: created.value,
      updatedAt: updated.value,
      archivedAt: null,
      settledOverride: input.settled === true ? "settled" : null,
      settledAt: input.settled === true ? updated.value : null,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId: input.instanceId,
      providerSessionId: null,
      appThreadId: input.threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: input.sessionId, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt: created.value,
      updatedAt: updated.value,
    };
    const events: OrchestrationV2DomainEvent[] = [
      {
        id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${input.threadId}`),
        type: "thread.created",
        threadId: input.threadId,
        providerInstanceId: input.instanceId,
        occurredAt: created.value,
        payload: appThread,
      },
      ...(history.omitted
        ? [
            {
              id: EventId.make(`${IMPORT_EVENT_PREFIX}:truncated:${input.threadId}`),
              type: "turn-item.updated" as const,
              threadId: input.threadId,
              occurredAt: created.value,
              payload: {
                id: TurnItemId.make(`${IMPORT_EVENT_PREFIX}:truncated:${input.threadId}`),
                threadId: input.threadId,
                runId: null,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "completed" as const,
                title: null,
                startedAt: created.value,
                completedAt: created.value,
                updatedAt: created.value,
                type: "system_notice" as const,
                message: `${history.omitted} earlier messages were not imported. The original session transcript is unchanged.`,
              },
            },
          ]
        : []),
      ...history.messages.flatMap((message, index) =>
        messageEvents({ threadId: input.threadId, index, message }),
      ),
      {
        id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider:${providerThreadId}`),
        type: "provider-thread.updated",
        threadId: input.threadId,
        driver,
        providerInstanceId: input.instanceId,
        occurredAt: updated.value,
        payload: providerThread,
      },
    ];
    const committed = yield* sink
      .write({ unlessNativeThreadOwned: providerThread, events })
      .pipe(Effect.result);
    if (committed._tag === "Failure") {
      const concurrent = yield* orchestrator
        .getThreadRecords(input.threadId, ["messages", "providerThreads"])
        .pipe(Effect.option);
      if (Option.isSome(concurrent)) {
        const owned = concurrent.value.providerThreads.some(
          (provider) =>
            provider.driver === input.driver &&
            provider.providerInstanceId === input.instanceId &&
            provider.nativeThreadRef?.nativeId === input.sessionId,
        );
        if (owned && concurrent.value.thread.projectId === input.projectId)
          return {
            threadId: input.threadId,
            created: false,
            messageCount: concurrent.value.messages.length,
          };
        return yield* new ImportError({
          status: 409,
          message: "Thread belongs to another session",
        });
      }
      return yield* new ImportError({ status: 500, message: "Could not import session" });
    }
    if (committed.success.length === 0)
      return yield* new ImportError({ status: 409, message: "Session is owned by another thread" });
    return { threadId: input.threadId, created: true, messageCount: history.messages.length };
  });
  return ImportSession.of({ run });
});

export const serviceLayer = Layer.effect(ImportSession, make);
const productionServiceLayer = serviceLayer.pipe(
  Layer.provide(Layer.merge(RuntimeLayer.layerEventSink, IdAllocator.layer)),
);
const handler = Effect.gen(function* () {
  yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const decoded = yield* request.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Input)),
    Effect.option,
  );
  if (Option.isNone(decoded))
    return yield* HttpServerResponse.json({ error: "Invalid import request" }, { status: 400 });
  const service = yield* ImportSession;
  const result = yield* service.run(decoded.value).pipe(Effect.result);
  if (result._tag === "Failure")
    return yield* HttpServerResponse.json(
      { error: result.failure.message },
      { status: result.failure.status },
    );
  return yield* HttpServerResponse.json(result.success);
});
export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const service = yield* ImportSession;
    yield* router.add(
      "POST",
      "/api/polaris/import-session",
      handler.pipe(Effect.provideService(ImportSession, service)),
    );
  }),
);
export const layer = routeLayer.pipe(Layer.provide(productionServiceLayer));
