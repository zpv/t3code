import { expect, it } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { createEventService } from "./events.ts";
import type { State } from "./state.ts";

it("keeps a run-start event in the outbox until acknowledged, including after restart", async () => {
  const projection = {
    thread: { id: "thread", modelSelection: { model: "model" }, archivedAt: null, deletedAt: null },
    messages: [],
    runtimeRequests: [],
    turnItems: [],
    providerThreads: [],
    runs: [{ id: "run", status: "running", userMessageId: "message" }],
  } as unknown as OrchestrationV2ThreadProjection;
  let state: State = {
    threads: {
      thread: {
        runId: "polaris-run",
        events: [],
        dispatched: ["message"],
        inputMessages: ["message"],
        outbox: [],
      },
    },
  };
  let saved = "";
  const save = () => {
    saved = JSON.stringify(state);
  };
  const posted: object[] = [];
  let acknowledge = false;
  const service = () =>
    createEventService({
      file: {},
      serverConfig: undefined,
      state,
      save,
      accounts: () => [],
      projection: async () => projection,
      changeAccount: async () => {},
      requireClient: () => {
        throw new Error("unexpected client");
      },
      commandId: () => {
        throw new Error("unexpected command");
      },
      messageId: () => {
        throw new Error("unexpected message");
      },
      threadId: () => {
        throw new Error("unexpected thread");
      },
      link: () => "link",
      log: () => {},
      postPolaris: async (path, body) => {
        if (path.endsWith("/events")) {
          posted.push(body);
          return acknowledge ? { ok: true } : null;
        }
        return { ok: true };
      },
    });
  await expect(service().flush("thread", projection)).rejects.toThrow("not acknowledged");
  expect(state.threads.thread?.outbox).toHaveLength(1);
  state = JSON.parse(saved) as State;
  acknowledge = true;
  await service().flush("thread", projection);
  await service().flush("thread", projection);
  expect(posted).toHaveLength(2);
  expect(posted[0]).toEqual(posted[1]);
  expect(posted[1]).toMatchObject({
    eventId: "t3:thread:run:run:started",
    type: "t3.run.started",
    payload: { origin: "polaris" },
  });
  expect(state.threads.thread?.outbox).toEqual([]);
});
