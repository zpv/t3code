import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { pendingRequest } from "./logic.ts";

export function turnState(p: OrchestrationV2ThreadProjection) {
  if (pendingRequest(p)) return "waiting";
  const run = p.runs.at(-1);
  if (!run) return "idle";
  if (["failed"].includes(run.status)) return "failed";
  if (["completed", "interrupted", "cancelled", "rolled_back"].includes(run.status)) return "idle";
  return "working";
}
export function effort(p: OrchestrationV2ThreadProjection) {
  return (
    p.thread.modelSelection.options?.find((o) => /effort|reasoning/i.test(o.id))?.value ?? null
  );
}
export function nativeSession(p: OrchestrationV2ThreadProjection) {
  const thread =
    p.providerThreads.find((t) => t.id === p.thread.activeProviderThreadId) ??
    p.providerThreads.findLast((t) => t.providerInstanceId === p.thread.providerInstanceId);
  return thread?.nativeThreadRef?.nativeId ?? null;
}
