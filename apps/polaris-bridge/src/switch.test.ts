import { describe, expect, it } from "@effect/vitest";
import { resumeSwitch } from "./switch.ts";
import type { Entry } from "./state.ts";

describe("durable account switch", () => {
  it.each(["intent", "move", "dispatch", "event", "offline"] as const)(
    "resumes after %s",
    async (failure) => {
      let saved: Entry = {
        runId: "run",
        events: [],
        dispatched: [],
        outbox: [],
        switching: {
          from: "a",
          to: "b",
          failedRunId: "failed",
          moveCommandId: "move",
          messageCommandId: "send",
          messageId: "message",
          event: {
            eventId: "switch",
            type: "t3.account.switched",
            source: "t3-bridge",
            payload: {},
          },
        },
      };
      let current = "a";
      const moves = new Set<string>();
      const messages = new Set<string>();
      const events = new Set<string>();
      let fail = true;
      const attempt = async () => {
        const entry = structuredClone(saved);
        await resumeSwitch("thread", entry, {
          save: () => {
            saved = structuredClone(entry);
          },
          current: async () => current,
          move: async (_from, to, commandId) => {
            moves.add(commandId);
            current = to;
            if (failure === "move" && fail) {
              fail = false;
              throw new Error("crash");
            }
            return true;
          },
          dispatch: async (intent) => {
            messages.add(intent.messageCommandId);
            if (failure === "dispatch" && fail) {
              fail = false;
              throw new Error("crash");
            }
          },
          post: async (event) => {
            if (failure === "offline" && fail) {
              fail = false;
              throw new Error("offline");
            }
            events.add(event.eventId);
            if (failure === "event" && fail) {
              fail = false;
              throw new Error("offline");
            }
          },
        });
      };
      if (failure !== "intent") await expect(attempt()).rejects.toThrow();
      await attempt();
      expect(current).toBe("b");
      expect(messages.size).toBe(1);
      expect(events.size).toBe(1);
      expect(saved.switching).toBeUndefined();
      expect(saved.dispatched).toContain("message");
      expect(saved.switchRuns).toContain("failed");
    },
  );
  it("abandons an unavailable target without dispatching a continuation", async () => {
    const entry: Entry = {
      runId: "run",
      events: [],
      dispatched: [],
      outbox: [],
      switching: {
        from: "a",
        to: "b",
        failedRunId: "failed",
        moveCommandId: "move",
        messageCommandId: "send",
        messageId: "message",
        event: { eventId: "switch", type: "t3.account.switched", source: "t3-bridge", payload: {} },
      },
    };
    let dispatched = false;
    expect(
      await resumeSwitch("thread", entry, {
        save: () => {},
        current: async () => "a",
        move: async () => false,
        dispatch: async () => {
          dispatched = true;
        },
        post: async () => {},
      }),
    ).toBe(false);
    expect(dispatched).toBe(false);
    expect(entry.switchRuns).toContain("failed");
    expect(entry.switching).toBeUndefined();
  });
});
