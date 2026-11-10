import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { post, type Project, type Run } from "./api";
import type { PolarisAccess } from "./state";

type Result = {
  plan: {
    targetBranch: string;
    workspace: { branch: string; path: string };
    resources: Record<string, unknown[] | null>;
  };
  operations: { action: string; ok: boolean; detail?: string }[];
};
export function CloseWorkspaceDialog({
  run,
  project,
  access,
  onClose,
  refresh,
}: {
  run: Run;
  project: Project | undefined;
  access: PolarisAccess;
  onClose: () => void;
  refresh: () => void;
}) {
  const [mode, setMode] = useState<"merge" | "abandon">("merge");
  const [push, setPush] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [previewing, setPreviewing] = useState(true);
  const [complete, setComplete] = useState(false);
  const path = `/v0/workspaces/${encodeURIComponent(run.workspaceId!)}/close`;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- previews the external workspace plan when options change
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError(null);
    setPreviewing(true);
    void post<Result>(
      access,
      path,
      { mode, push, deleteBranch, dryRun: true },
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) {
          setResult(value);
          setPreviewing(false);
        }
      },
      (cause) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setPreviewing(false);
        }
      },
    );
    return () => controller.abort();
  }, [access, path, mode, push, deleteBranch]);
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      setResult(await post<Result>(access, path, { mode, push, deleteBranch, dryRun: false }));
      setComplete(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setPending(false);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending && !previewing) {
          if (complete) refresh();
          onClose();
        }
      }}
    >
      <DialogPopup showCloseButton={!pending && !previewing}>
        <DialogHeader>
          <DialogTitle>Close workspace</DialogTitle>
          <DialogDescription>Close the workspace used by {run.name}.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4 text-sm">
            {!complete ? (
              <>
                <div className="space-y-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="close-mode"
                      checked={mode === "merge"}
                      disabled={pending}
                      onChange={() => {
                        setResult(null);
                        setPreviewing(true);
                        setMode("merge");
                      }}
                    />
                    Merge into {project?.defaultBranch || "default branch"}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="close-mode"
                      checked={mode === "abandon"}
                      disabled={pending}
                      onChange={() => {
                        setResult(null);
                        setPreviewing(true);
                        setMode("abandon");
                      }}
                    />
                    Abandon
                  </label>
                </div>
                <div className="flex gap-5">
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={push}
                      disabled={pending || mode === "abandon"}
                      onCheckedChange={(value) => {
                        setResult(null);
                        setPreviewing(true);
                        setPush(value);
                      }}
                    />
                    Push
                  </label>
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={deleteBranch}
                      disabled={pending}
                      onCheckedChange={(value) => {
                        setResult(null);
                        setPreviewing(true);
                        setDeleteBranch(value);
                      }}
                    />
                    Delete branch
                  </label>
                </div>
              </>
            ) : null}
            {error ? <p className="text-destructive">{error}</p> : null}
            {result ? (
              <div className="max-h-64 space-y-1 overflow-auto rounded-md border p-3">
                {complete ? (
                  result.operations.map((operation, i) => (
                    <p key={i}>
                      {operation.ok ? "✓" : "Failed:"} {operation.action}
                      {operation.detail ? `: ${operation.detail}` : ""}
                    </p>
                  ))
                ) : (
                  <>
                    <p>
                      Stop workspace runs and release resources (
                      {Object.values(result.plan.resources).reduce(
                        (sum, items) => sum + (items?.length ?? 0),
                        0,
                      )}{" "}
                      active).
                    </p>
                    {mode === "merge" ? (
                      <p>
                        Merge {result.plan.workspace.branch} into {result.plan.targetBranch}
                        {push ? " and push" : ""}.
                      </p>
                    ) : (
                      <p>Abandon {result.plan.workspace.branch}.</p>
                    )}
                    <p>Remove worktree {result.plan.workspace.path}.</p>
                    {deleteBranch ? <p>Delete branch {result.plan.workspace.branch}.</p> : null}
                  </>
                )}
              </div>
            ) : !error ? (
              <p className="text-muted-foreground">Checking workspace…</p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={pending || previewing}
            onClick={() => {
              if (complete) refresh();
              onClose();
            }}
          >
            {complete ? "Close" : "Cancel"}
          </Button>
          {!complete ? (
            <Button
              variant={mode === "abandon" ? "destructive" : "default"}
              disabled={pending || !result || !!error}
              onClick={() => void submit()}
            >
              {pending ? "Closing…" : mode === "abandon" ? "Abandon workspace" : "Close workspace"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
