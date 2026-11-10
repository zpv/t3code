import { describe, expect, it } from "vite-plus/test";
import { qrValue, visibleBriefRuns } from "./logic";
import { cueForTransition, noteSchedule } from "./sound";
import type { BriefRun } from "./api";

describe("Polaris gaps", () => {
  it("filters open Brief items by owner, dismissal, and snooze", () => {
    const item = {
      id: "a",
      title: "Check",
      owner: "user",
      status: "open",
      quote: "",
      createdAt: "2026-01-01",
    };
    const runs: BriefRun[] = [
      {
        runId: "r",
        name: "Run",
        state: "waiting",
        headline: "Waiting",
        summary: "",
        items: [
          item,
          { ...item, id: "b", owner: "agent" },
          { ...item, id: "c", status: "resolved" },
          { ...item, id: "d", dismissedAt: "2026-01-01" },
          { ...item, id: "e", snoozedUntil: "2030-01-01" },
        ],
      },
    ];
    expect(visibleBriefRuns(runs, false, 0)[0]?.items.map((i) => i.id)).toEqual(["a"]);
    expect(visibleBriefRuns(runs, true, 0)[0]?.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(visibleBriefRuns([{ ...runs[0]!, items: [] }], true, 0)).toEqual([]);
  });
  it.each([
    [true, false, false, false, false, 2000, "completion"],
    [true, true, false, false, false, 2000, "input"],
    [true, false, true, false, false, 2000, null],
    [true, false, false, true, false, 2000, null],
    [true, false, false, false, false, 1999, null],
    [false, false, false, false, false, 2000, null],
    [true, false, false, false, true, 2000, null],
  ] as const)(
    "decides cue from active %s, input %s, focus %s, initial %s",
    (active, input, focus, initial, stillActive, elapsed, expected) => {
      expect(
        cueForTransition(
          { active, input: false, reply: false, activeRunId: "r" },
          { active: stillActive, input, reply: true, replyRunId: "r" },
          focus,
          initial,
          elapsed,
        ),
      ).toBe(expected);
    },
  );
  it("does not play an old reply when a different run stops", () => {
    expect(
      cueForTransition(
        { active: true, input: false, reply: false, activeRunId: "new" },
        { active: false, input: false, reply: true, replyRunId: "old" },
        false,
        false,
        2000,
      ),
    ).toBeNull();
  });
  it("schedules both figures and selects QR input", () => {
    expect(
      noteSchedule("completion").map((n) => [n.frequency, n.start, n.attack, n.release]),
    ).toEqual([
      [659.255, 0, 0.006, 0.06],
      [783.991, 0.09, 0.006, 0.06],
      [1046.502, 0.18, 0.006, 0.06],
    ]);
    expect(noteSchedule("input").map((n) => n.frequency)).toEqual([783.991, 659.255]);
    expect(qrValue("thread", "thread", "launcher")).toBe("thread");
    expect(qrValue("launcher", "thread", "launcher")).toBe("launcher");
  });
});
