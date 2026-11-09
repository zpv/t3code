import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { ClaudeOrchestratorReplayHarness } from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { CLAUDE_MODEL_SELECTION } from "../orchestration-v2/testkit/fixtures/shared.ts";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ImportSession from "./ImportSession.ts";

it.live(
  "imports visible history once, rejects another owner, and dispatches the first turn without a handoff",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "polaris-import-test-" });
        const transcriptPath = `${directory}/session.jsonl`;
        const sessionId = "1d1e5e55-1041-4e40-8e40-000000000001";
        const timestamp = "2026-09-01T10:00:00.000Z";
        const records = Array.from({ length: 410 }, (_, index) =>
          JSON.stringify({
            type: index % 2 ? "assistant" : "user",
            sessionId,
            timestamp,
            message: { role: index % 2 ? "assistant" : "user", content: `message ${index}` },
          }),
        );
        yield* fs.writeFileString(transcriptPath, records.join("\n"));
        yield* fs.makeDirectory(`${directory}/.claude/projects/worktree`, { recursive: true });
        yield* fs.writeFileString(
          `${directory}/.claude/projects/worktree/${sessionId}.jsonl`,
          records.join("\n"),
        );
        const raw = yield* readProviderReplayTranscript(
          new URL(
            "../orchestration-v2/testkit/fixtures/claude_idle_resume/claude_transcript.ndjson",
            import.meta.url,
          ),
        );
        const resumeIndex = raw.entries.findIndex(
          (entry) => entry.type === "expect_outbound" && entry.label === "query.open:2",
        );
        const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
          ...raw,
          entries: raw.entries.slice(resumeIndex),
        });
        const scenario = {
          name: "polaris-import",
          transcript,
          commands: [],
          projectionThreadIds: [],
        };
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const services = yield* Layer.build(
            ImportSession.serviceLayer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
                  Layer.succeed(EventSink.EventSinkV2, sink),
                  IdAllocator.layer,
                  ServerSettings.layerTest(),
                  Layer.mock(ProjectService.ProjectService)({
                    getById: () =>
                      Effect.succeedSome({
                        id: ProjectId.make("project:polaris"),
                        title: "test",
                        workspaceRoot: directory,
                        defaultModelSelection: null,
                        scripts: [],
                        createdAt: timestamp,
                        updatedAt: timestamp,
                        deletedAt: null,
                      }),
                  }),
                  NodeServices.layer,
                ),
              ),
            ),
          );
          const importer = Context.get(services, ImportSession.ImportSession);
          const input = {
            threadId: ThreadId.make("polaris-run"),
            driver: "claudeAgent" as const,
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            sessionId,
            transcriptPath,
            projectId: ProjectId.make("project:polaris"),
            title: "Imported",
            worktreePath: directory,
            branch: "test",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access" as const,
            settled: true,
          };
          assert.deepEqual(yield* importer.run(input), {
            threadId: input.threadId,
            created: true,
            messageCount: 400,
          });
          assert.deepEqual(yield* importer.run(input), {
            threadId: input.threadId,
            created: false,
            messageCount: 400,
          });
          const conflict = yield* importer
            .run({ ...input, threadId: ThreadId.make("polaris-other") })
            .pipe(Effect.flip);
          assert.equal(conflict.status, 409);
          const makeHandler = (
            scopes: ReadonlyArray<
              typeof AuthOrchestrationOperateScope | typeof AuthOrchestrationReadScope
            >,
            missing = false,
          ) =>
            HttpRouter.toWebHandler(
              ImportSession.routeLayer.pipe(
                Layer.provideMerge(Layer.succeed(ImportSession.ImportSession, importer)),
                Layer.provideMerge(
                  Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
                    authenticateWebSocketUpgrade: () =>
                      missing
                        ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
                        : Effect.succeed({
                            sessionId: AuthSessionId.make("test"),
                            subject: "test",
                            method: "bearer-access-token",
                            scopes,
                          }),
                  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
                ),
              ),
              { disableLogger: true },
            );
          const operator = makeHandler([AuthOrchestrationOperateScope]);
          const reader = makeHandler([AuthOrchestrationReadScope]);
          const unauthenticated = makeHandler([], true);
          yield* Effect.addFinalizer(() =>
            Effect.promise(() =>
              Promise.all([operator.dispose(), reader.dispose(), unauthenticated.dispose()]).then(
                () => undefined,
              ),
            ),
          );
          const request = (body: unknown) =>
            new Request("http://t3.test/api/polaris/import-session", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
          assert.equal(
            (yield* Effect.promise(() => unauthenticated.handler(request(input)))).status,
            401,
          );
          assert.equal((yield* Effect.promise(() => reader.handler(request(input)))).status, 403);
          assert.equal((yield* Effect.promise(() => operator.handler(request({})))).status, 400);
          const repeatResponse = yield* Effect.promise(() => operator.handler(request(input)));
          assert.equal(repeatResponse.status, 200);
          assert.deepEqual(yield* Effect.promise(() => repeatResponse.json()), {
            threadId: input.threadId,
            created: false,
            messageCount: 400,
          });
          const conflictResponse = yield* Effect.promise(() =>
            operator.handler(request({ ...input, threadId: "polaris-conflict" })),
          );
          assert.equal(conflictResponse.status, 409);
          const { transcriptPath: _path, ...withoutPath } = input;
          const locatedConflict = yield* importer
            .run({ ...withoutPath, threadId: ThreadId.make("polaris-located") })
            .pipe(Effect.flip);
          assert.equal(locatedConflict.status, 409);
          const missing = yield* importer
            .run({
              ...withoutPath,
              threadId: ThreadId.make("polaris-missing"),
              sessionId: "missing",
            })
            .pipe(Effect.flip);
          assert.equal(missing.status, 409);
          const codexId = "c3ed201e-a918-42ac-a0b3-c2515e4f5566";
          yield* fs.makeDirectory(`${directory}/.codex/sessions/2026/09/01`, { recursive: true });
          yield* fs.writeFileString(
            `${directory}/.codex/sessions/2026/09/01/rollout-${codexId}_rewound.jsonl`,
            [
              JSON.stringify({ type: "session_meta", payload: { id: codexId } }),
              JSON.stringify({
                type: "event_msg",
                timestamp,
                payload: { type: "user_message", message: "Codex question" },
              }),
              JSON.stringify({
                type: "response_item",
                timestamp,
                payload: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "Codex question" }],
                },
              }),
              JSON.stringify({
                type: "response_item",
                timestamp,
                payload: {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Codex answer" }],
                },
              }),
            ].join("\n"),
          );
          const codexInput = {
            ...withoutPath,
            threadId: ThreadId.make("polaris-codex"),
            driver: "codex" as const,
            instanceId: ProviderInstanceId.make("codex"),
            sessionId: codexId,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            settled: false,
          };
          const codex = yield* importer.run(codexInput);
          assert.equal(codex.messageCount, 2);
          const codexProjection = yield* orchestrator.getThreadProjection(codexInput.threadId);
          assert.deepEqual(
            codexProjection.messages.map((message) => message.text),
            ["Codex question", "Codex answer"],
          );
          assert.isNull(codexProjection.thread.settledOverride);
          const wrongSession = yield* importer
            .run({
              ...codexInput,
              threadId: ThreadId.make("polaris-wrong"),
              sessionId: "wrong",
              transcriptPath: `${directory}/.codex/sessions/2026/09/01/rollout-${codexId}_rewound.jsonl`,
            })
            .pipe(Effect.flip);
          assert.equal(wrongSession.status, 409);
          const raceSession = "1d1e5e55-1041-4e40-8e40-000000000099";
          const racePath = `${directory}/race.jsonl`;
          yield* fs.writeFileString(
            racePath,
            JSON.stringify({
              type: "user",
              sessionId: raceSession,
              timestamp,
              message: { role: "user", content: "race" },
            }),
          );
          const raceInput = {
            ...input,
            threadId: ThreadId.make("polaris-race"),
            sessionId: raceSession,
            transcriptPath: racePath,
          };
          const concurrent = yield* Effect.all([importer.run(raceInput), importer.run(raceInput)], {
            concurrency: "unbounded",
          });
          assert.deepEqual(concurrent.map((result) => result.created).sort(), [false, true]);
          const longCodexId = "c3ed201e-a918-42ac-a0b3-c2515e4f5599";
          const longCodexPath = `${directory}/long-codex.jsonl`;
          yield* fs.writeFileString(
            longCodexPath,
            [
              JSON.stringify({ type: "session_meta", payload: { id: longCodexId } }),
              ...Array.from({ length: 410 }, (_, index) =>
                JSON.stringify({
                  type: "event_msg",
                  timestamp,
                  payload: { type: "user_message", message: `codex ${index}` },
                }),
              ),
            ].join("\n"),
          );
          const longCodexInput = {
            ...codexInput,
            threadId: ThreadId.make("polaris-long-codex"),
            sessionId: longCodexId,
            transcriptPath: longCodexPath,
          };
          const longCodex = yield* importer.run(longCodexInput);
          assert.equal(longCodex.messageCount, 400);
          const longProjection = yield* orchestrator.getThreadProjection(longCodexInput.threadId);
          assert.equal(longProjection.messages[0]?.text, "codex 0");
          assert.equal(longProjection.messages[1]?.text, "codex 11");
          assert.equal(longProjection.messages.at(-1)?.text, "codex 409");
          const pairedId = "c3ed201e-a918-42ac-a0b3-c2515e4f5577";
          const pairedPath = `${directory}/paired-codex.jsonl`;
          const pairs = Array.from({ length: 210 }, (_, index) => [
            JSON.stringify({
              type: "event_msg",
              timestamp,
              payload: { type: "user_message", message: `pair ${index}` },
            }),
            JSON.stringify({
              type: "response_item",
              timestamp,
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: `pair ${index}` }],
              },
            }),
          ]).flat();
          yield* fs.writeFileString(
            pairedPath,
            [JSON.stringify({ type: "session_meta", payload: { id: pairedId } }), ...pairs].join(
              "\n",
            ),
          );
          const pairedInput = {
            ...codexInput,
            threadId: ThreadId.make("polaris-paired-codex"),
            sessionId: pairedId,
            transcriptPath: pairedPath,
          };
          const paired = yield* importer.run(pairedInput);
          assert.equal(paired.messageCount, 210);
          const pairedProjection = yield* orchestrator.getThreadProjection(pairedInput.threadId);
          assert.deepEqual(
            pairedProjection.messages.map((message) => message.text),
            Array.from({ length: 210 }, (_, index) => `pair ${index}`),
          );
          const repeatedId = "c3ed201e-a918-42ac-a0b3-c2515e4f5588";
          const repeatedPath = `${directory}/repeated-codex.jsonl`;
          const repeatedPairs = Array.from({ length: 210 }, () => [
            JSON.stringify({
              type: "event_msg",
              timestamp,
              payload: { type: "user_message", message: "repeat" },
            }),
            JSON.stringify({
              type: "response_item",
              timestamp,
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "repeat" }],
                internal_chat_message_metadata_passthrough: { turn_id: "same-turn" },
              },
            }),
          ]).flat();
          yield* fs.writeFileString(
            repeatedPath,
            [
              JSON.stringify({ type: "session_meta", payload: { id: repeatedId } }),
              ...repeatedPairs,
            ].join("\n"),
          );
          const repeated = yield* importer.run({
            ...codexInput,
            threadId: ThreadId.make("polaris-repeated-codex"),
            sessionId: repeatedId,
            transcriptPath: repeatedPath,
          });
          assert.equal(repeated.messageCount, 210);
          const overlapId = "c3ed201e-a918-42ac-a0b3-c2515e4f5500";
          const overlapPath = `${directory}/overlap-codex.jsonl`;
          yield* fs.writeFileString(
            overlapPath,
            [
              JSON.stringify({ type: "session_meta", payload: { id: overlapId } }),
              JSON.stringify({
                type: "event_msg",
                timestamp,
                payload: { type: "user_message", message: "earlier" },
              }),
              ...Array.from({ length: 210 }, (_, index) =>
                JSON.stringify({
                  type: "event_msg",
                  timestamp,
                  payload: { type: "user_message", message: `other ${index}` },
                }),
              ),
              JSON.stringify({
                type: "response_item",
                timestamp,
                payload: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "earlier" }],
                },
              }),
            ].join("\n"),
          );
          const overlap = yield* importer.run({
            ...codexInput,
            threadId: ThreadId.make("polaris-overlap-codex"),
            sessionId: overlapId,
            transcriptPath: overlapPath,
          });
          assert.equal(overlap.messageCount, 212);
          const before = yield* orchestrator.getThreadProjection(input.threadId);
          assert.equal(before.messages.length, 400);
          assert.equal(before.messages[0]?.text, "message 0");
          assert.equal(before.messages[1]?.text, "message 11");
          assert.equal(before.messages.at(-1)?.text, "message 409");
          assert.isTrue(before.turnItems.some((item) => item.type === "system_notice"));
          assert.equal(before.thread.historyOrigin, "native");
          assert.equal(before.thread.worktreePath, directory);
          assert.equal(before.thread.settledOverride, "settled");
          assert.equal(before.providerThreads[0]?.nativeThreadRef?.nativeId, sessionId);
          const terminal = yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.threadId === input.threadId &&
                (event.payload.status === "completed" || event.payload.status === "failed"),
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("polaris-message"),
            threadId: input.threadId,
            messageId: MessageId.make("polaris-message"),
            createdBy: "user",
            creationSource: "web",
            text: "Respond with exactly: idle resume second turn complete",
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          yield* Fiber.join(terminal);
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          const after = yield* orchestrator.getThreadProjection(input.threadId);
          assert.lengthOf(after.contextHandoffs, 0);
          assert.equal(after.runs[0]?.contextHandoffId, null);
          assert.equal(after.providerThreads[0]?.nativeThreadRef?.nativeId, sessionId);
          assert.equal(after.runs[0]?.status, "completed");
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerProviderReplay(scenario, ClaudeOrchestratorReplayHarness),
          ),
          Effect.provideService(HostProcess.HomeDirectory, directory),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
