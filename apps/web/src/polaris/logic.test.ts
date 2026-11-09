import { describe, expect, it } from "vite-plus/test";
import { EventParser, errorMessage, type Run } from "./api";
import { groupRuns, migrationCounts, reasonText, runState } from "./logic";

describe("Polaris data", () => {
  it("parses split named frames, skips heartbeats and resumes without duplicates", () => {
    const parser = new EventParser();
    expect(parser.push(": heartbeat\r\n\r\nid: 4\r")).toEqual([]);
    expect(parser.push('\nevent: run.updated\ndata: {"id":4}\n\n')).toEqual([
      { id: 4, type: "run.updated", data: '{"id":4}' },
    ]);
    expect(
      parser.push(
        "id: 4\nevent: run.updated\ndata: {}\n\nid: 5\nevent: port.created\ndata: {}\n\n",
      ),
    ).toEqual([{ id: 5, type: "port.created", data: "{}" }]);
    expect(parser.lastId).toBe(5);
  });
  it("groups and filters runs, keeping agents before services and recent first", () => {
    const base = { status: "running", updatedAt: "2026-01-01", name: "Run", agent: "codex" };
    const runs: Run[] = [
      { ...base, id: "old", projectId: "p" },
      { ...base, id: "new", projectId: "p", updatedAt: "2026-02-01" },
      { ...base, id: "shell", projectId: "p", agent: "shell", updatedAt: "2026-03-01" },
      { ...base, id: "stop", status: "stopped" },
    ];
    expect(
      groupRuns(runs, [{ id: "p", name: "Project" }], "project", true)[0]?.runs.map((r) => r.id),
    ).toEqual(["new", "old", "shell"]);
    expect(groupRuns(runs, [], "stop", true)).toEqual([]);
    expect(runState({ ...base, id: "x", backend: "tmux", turnState: "working" })).toBe("running");
    expect(runState({ ...base, id: "x", backend: "t3", turnState: "waiting" })).toBe("waiting");
  });
  it("summarizes migration and extracts daemon errors", () => {
    expect(
      migrationCounts([
        { runId: "1", name: "a", agent: "codex", action: "migrate" },
        { runId: "2", name: "b", agent: "claude", action: "deferred", reason: "live" },
        { runId: "3", name: "c", agent: "codex", action: "skipped" },
      ]),
    ).toEqual({ move: 1, deferred: 1, skipped: 1 });
    expect(
      ["live", "working", "no-session", "worktree-missing", "liveness-unknown"].map(reasonText),
    ).toEqual([
      "running in tmux",
      "mid-turn",
      "no saved session",
      "worktree deleted",
      "tmux unreachable",
    ]);
    expect([
      errorMessage({ error: "bad" }, "x"),
      errorMessage({ ok: false, reason: "no" }, "x"),
      errorMessage({ stderr: "failed" }, "x"),
    ]).toEqual(["bad", "no", "failed"]);
  });
});
