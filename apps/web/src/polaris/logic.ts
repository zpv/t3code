import type { BriefRun, MigrationRow, Project, Run } from "./api";
export function groupRuns(runs: Run[], projects: Project[], search: string, activeOnly: boolean) {
  const query = search.toLowerCase();
  const groups = new Map<string, { name: string; runs: Run[] }>();
  for (const run of runs) {
    const name = projects.find((project) => project.id === run.projectId)?.name ?? "No project";
    if (activeOnly && ["stopped", "failed"].includes(run.status)) continue;
    if (![run.name, name, run.branch, run.id].some((part) => part?.toLowerCase().includes(query)))
      continue;
    const key = run.projectId || "";
    const group = groups.get(key) ?? { name, runs: [] };
    group.runs.push(run);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((group) => ({
      ...group,
      runs: group.runs.sort(
        (a, b) =>
          Number(a.agent === "shell") - Number(b.agent === "shell") ||
          b.updatedAt.localeCompare(a.updatedAt),
      ),
    }));
}
export function runState(run: Run) {
  if (run.status === "stopped") return "stopped";
  if (run.status === "failed") return "failed";
  return run.backend === "t3"
    ? run.turnState || "idle"
    : run.status === "running"
      ? "running"
      : run.status;
}
export function reasonText(reason?: string) {
  return (
    (
      {
        live: "running in tmux",
        working: "mid-turn",
        "no-session": "no saved session",
        "worktree-missing": "worktree deleted",
        "liveness-unknown": "tmux unreachable",
      } as Record<string, string>
    )[reason ?? ""] ??
    reason ??
    ""
  );
}
export function migrationCounts(rows: MigrationRow[]) {
  return {
    move: rows.filter((r) => r.action === "migrate").length,
    deferred: rows.filter((r) => r.action === "deferred").length,
    skipped: rows.filter((r) => r.action === "skipped").length,
  };
}

export function visibleBriefRuns(runs: BriefRun[], showAgent: boolean, now: number) {
  return runs
    .map((run) => ({
      ...run,
      items: (run.items ?? []).filter(
        (item) =>
          item.status === "open" &&
          !item.dismissedAt &&
          !item.hiddenReason &&
          (!item.snoozedUntil || Date.parse(item.snoozedUntil) <= now) &&
          (showAgent || item.owner !== "agent"),
      ),
    }))
    .filter((run) => run.items.length > 0);
}
export function qrValue(kind: "thread" | "launcher", threadUrl: string, launcherUrl: string) {
  return kind === "thread" ? threadUrl : launcherUrl;
}
