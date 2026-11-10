import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { post, request, type BriefData } from "./api";
import { relativeTime } from "./actions";
import { visibleBriefRuns } from "./logic";
import type { PolarisAccess } from "./state";
import type { Data } from "./usePolaris";

export function Brief({
  brief,
  data,
  access,
  refresh,
  onRun,
}: {
  brief: BriefData;
  data: Data;
  access: PolarisAccess;
  refresh: () => void;
  onRun: (id: string) => void;
}) {
  const [showAgent, setShowAgent] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const runs = visibleBriefRuns(brief.runs ?? [], showAgent, Date.now());
  const edit = async (runId: string, itemId: string, action: string, snoozedUntil?: string) => {
    setPending(itemId);
    try {
      await request(
        access,
        `/v0/brief/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(itemId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, ...(snoozedUntil ? { snoozedUntil } : {}) }),
        },
      );
      refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not update item",
        description: String(error),
      });
    }
    setPending(null);
  };
  const refreshBrief = async () => {
    try {
      await post(access, "/v0/brief/refresh");
      refresh();
    } catch (error) {
      toastManager.add({ type: "error", title: "Refresh failed", description: String(error) });
    }
  };
  if (!brief.enabled)
    return <p className="text-sm text-muted-foreground">Brief is disabled on this host.</p>;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <Switch size="sm" checked={showAgent} onCheckedChange={setShowAgent} />
          Show agent activity
        </label>
        <div className="ms-auto flex items-center gap-3">
          {brief.providerRetryAt ? (
            <span className="text-muted-foreground">
              Provider paused until {new Date(brief.providerRetryAt).toLocaleString()}
              {brief.providerIssue ? `: ${brief.providerIssue}` : ""}
            </span>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => void refreshBrief()}>
            Refresh
          </Button>
        </div>
      </div>
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing needs you.</p>
      ) : (
        runs.map((run) => {
          const target = data.runs.find((r) => r.id === run.runId);
          return (
            <section key={run.runId} className="overflow-hidden rounded-lg border">
              <div className="space-y-1 border-b px-4 py-3">
                <div className="flex items-center gap-2">
                  <span
                    aria-label={run.state}
                    className={`size-2 rounded-full ${run.state === "waiting" ? "bg-warning-foreground" : run.state === "working" ? "bg-primary" : "bg-muted-foreground/50"}`}
                  />
                  <button className="font-medium hover:underline" onClick={() => onRun(run.runId)}>
                    {target?.name ?? run.name}
                  </button>
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  {run.headline || run.summary}
                </p>
              </div>
              {run.items.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center gap-3 border-b px-4 py-3 text-sm last:border-0"
                >
                  <div className="min-w-48 flex-1">
                    <p>{item.title}</p>
                    <p className="line-clamp-2 text-muted-foreground">{item.quote}</p>
                  </div>
                  <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    {relativeTime(item.createdAt)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() => void edit(run.runId, item.id, "resolve")}
                  >
                    Done
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() => void edit(run.runId, item.id, "dismiss")}
                  >
                    Dismiss
                  </Button>
                  <Menu>
                    <MenuTrigger
                      render={<Button variant="ghost" size="sm" disabled={pending !== null} />}
                    >
                      Snooze
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem
                        onClick={() =>
                          void edit(
                            run.runId,
                            item.id,
                            "snooze",
                            new Date(Date.now() + 3600000).toISOString(),
                          )
                        }
                      >
                        1h
                      </MenuItem>
                      <MenuItem
                        onClick={() => {
                          const tomorrow = new Date();
                          tomorrow.setDate(tomorrow.getDate() + 1);
                          tomorrow.setHours(9, 0, 0, 0);
                          void edit(run.runId, item.id, "snooze", tomorrow.toISOString());
                        }}
                      >
                        Until tomorrow
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </div>
              ))}
            </section>
          );
        })
      )}
    </div>
  );
}
