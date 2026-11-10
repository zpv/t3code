// @effect-diagnostics nodeBuiltinImport:off -- The test reopens a real state file.
import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { OrchestrationV2Command } from "@t3tools/contracts";
import { createInputReceipts } from "./inputReceipts.ts";
import { openState, type State } from "./state.ts";
import { Refusal } from "./t3Client.ts";

const command = {
  type: "message.dispatch",
  commandId: "command",
  threadId: "thread",
  messageId: "message",
} as OrchestrationV2Command;
const response = { ok: true, delivery: "started", messageId: "message" };
const event = {
  eventId: "switch",
  type: "t3.account.switched",
  source: "t3-bridge" as const,
  payload: {},
};

describe("input receipts", () => {
  it("recovers an accepted command after its response is lost and replays the original response", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bridge-receipts-"));
    try {
      let { state, save } = openState(NodePath.join(dir, "state.json"));
      state.threads.thread = { runId: "run", events: [], dispatched: [], outbox: [] };
      const accepted = new Set<string>();
      let calls = 0;
      const lost = createInputReceipts(state, save, async (cmd) => {
        accepted.add(cmd.commandId);
        calls++;
        throw new Error("lost response");
      });
      await expect(lost("thread", "key", (send) => send(command, response, event))).rejects.toThrow(
        "lost response",
      );
      ({ state, save } = openState(NodePath.join(dir, "state.json")));
      const resumed = createInputReceipts(state, save, async (cmd) => {
        accepted.add(cmd.commandId);
        calls++;
      });
      const unexpected = () => {
        throw new Error("must not run");
      };
      expect(await resumed("thread", "key", unexpected)).toEqual(response);
      expect(await resumed("thread", "key", unexpected)).toEqual(response);
      expect(accepted.size).toBe(1);
      expect(calls).toBe(2);
      expect(state.threads.thread?.outbox).toEqual([event]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("serializes concurrent retries, scopes keys by thread, and prunes expired receipts", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(10 * 24 * 60 * 60 * 1000);
    const state = {
      threads: {
        one: {
          runId: "one",
          events: [],
          dispatched: [],
          outbox: [],
          inputs: {
            old: { createdAt: 0, response: {} },
            pending: { createdAt: 3 * 24 * 60 * 60 * 1000, response: {}, pending: true },
          },
        },
        two: { runId: "two", events: [], dispatched: [], outbox: [] },
      },
    };
    let calls = 0;
    const receipt = createInputReceipts(
      state,
      () => {},
      async () => {
        calls++;
      },
    );
    const operation = (send: Parameters<Parameters<typeof receipt>[2]>[0]) =>
      send(command, response);
    expect(
      await Promise.all([receipt("one", "same", operation), receipt("one", "same", operation)]),
    ).toEqual([response, response]);
    await receipt("two", "same", operation);
    expect(calls).toBe(2);
    expect(state.threads.one.inputs.old).toBeUndefined();
    expect(state.threads.one.inputs.pending).toBeDefined();
  });
  it("replays refusals and locally recorded answers without repeating their work", async () => {
    const state: State = {
      threads: { thread: { runId: "run", events: [], dispatched: [], outbox: [] } },
    };
    const receipt = createInputReceipts(
      state,
      () => {},
      async () => {
        throw new Error("unexpected dispatch");
      },
    );
    let calls = 0;
    const refused = async () => {
      calls++;
      throw new Refusal("No terminal keys");
    };
    await expect(receipt("thread", "refused", refused)).rejects.toThrow("No terminal keys");
    await expect(receipt("thread", "refused", refused)).rejects.toThrow("No terminal keys");
    const local = async (
      _send: Parameters<Parameters<typeof receipt>[2]>[0],
      record: Parameters<Parameters<typeof receipt>[2]>[1],
    ) => {
      calls++;
      record(response);
      throw new Error("lost after local save");
    };
    await expect(receipt("thread", "local", local)).rejects.toThrow("lost after local save");
    expect(await receipt("thread", "local", local)).toEqual(response);
    expect(calls).toBe(2);
  });
});
