import { useEffect, useState } from "react";
import type { PolarisAccess } from "./state";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { toastManager } from "~/components/ui/toast";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { post, type Migration, type Project } from "./api";
import { migrationCounts, reasonText } from "./logic";

export function MigrationDialog({
  access,
  projects,
  environmentId,
  runId,
  onClose,
  refresh,
}: {
  access: PolarisAccess;
  projects: Project[];
  environmentId: string;
  runId: string | null;
  onClose: () => void;
  refresh: () => void;
}) {
  const [includeLive, setIncludeLive] = useState(false);
  const [result, setResult] = useState<Migration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests a new dry run when migration options change
  useEffect(() => {
    const controller = new AbortController();
    void post<Migration>(
      access,
      "/v0/t3/migrate",
      {
        dryRun: true,
        includeLive,
        ...(runId ? { runIds: [runId] } : {}),
      },
      controller.signal,
    ).then(
      (next) => {
        if (!controller.signal.aborted) {
          setResult(next);
          setError(null);
        }
      },
      (cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => controller.abort();
  }, [access, includeLive, runId]);
  const counts = migrationCounts(result?.results ?? []);
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      setResult(
        await post<Migration>(access, "/v0/t3/migrate", {
          dryRun: false,
          includeLive,
          ...(runId ? { runIds: [runId] } : {}),
        }),
      );
      setComplete(true);
      toastManager.add({ type: "success", title: "Migration finished" });
      refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      toastManager.add({ type: "error", title: "Migration failed", description: message });
    }
    setPending(false);
  };
  const groups = new Map<string, Migration["results"]>();
  for (const row of result?.results ?? []) {
    const name = projects.find((p) => p.id === row.projectId)?.name ?? "No project";
    const group = groups.get(name) ?? [];
    group.push(row);
    groups.set(name, group);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Move runs to T3</DialogTitle>
          <DialogDescription>
            Runs active in the last 14 days, plus the 5 most recent per project.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4 overflow-auto text-sm">
            {error ? <p className="text-destructive">{error}</p> : null}
            {!result ? (
              <p className="text-muted-foreground">Checking runs…</p>
            ) : (
              <>
                <p className="text-muted-foreground">
                  {complete
                    ? `${result.results.filter((row) => row.action === "migrated").length} moved`
                    : `${counts.move} will move`}{" "}
                  · {counts.deferred} deferred · {counts.skipped} skipped
                </p>
                <div className="max-h-72 space-y-4 overflow-auto">
                  {[...groups].map(([name, rows]) => (
                    <section key={name}>
                      <h3 className="mb-1 font-medium">{name}</h3>
                      {rows.map((row) => (
                        <div
                          key={row.runId}
                          className="flex items-center gap-3 border-b py-2 last:border-0"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {row.threadId ? (
                              <a
                                href={`/${encodeURIComponent(environmentId)}/${encodeURIComponent(row.threadId)}`}
                                className="underline"
                              >
                                {row.name}
                              </a>
                            ) : (
                              row.name
                            )}
                          </span>
                          <span className="text-muted-foreground">{row.agent}</span>
                          <span className="text-muted-foreground">
                            {row.action === "failed" ? "Failed: " : ""}
                            {reasonText(row.reason) ||
                              (row.action === "migrated"
                                ? "Moved"
                                : row.action === "migrate"
                                  ? "Will move"
                                  : row.action)}
                          </span>
                        </div>
                      ))}
                    </section>
                  ))}
                </div>
              </>
            )}
            {!complete ? (
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={includeLive}
                  disabled={pending}
                  onCheckedChange={(checked) => {
                    setResult(null);
                    setIncludeLive(checked);
                  }}
                />
                <span>Also move idle runs that are open in tmux (closes their terminal)</span>
              </label>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {complete ? "Close" : "Cancel"}
          </Button>
          {!complete ? (
            <Button disabled={pending || counts.move === 0} onClick={() => void submit()}>
              {pending ? "Moving…" : `Move ${counts.move} runs`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
