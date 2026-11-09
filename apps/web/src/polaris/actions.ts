import type { PolarisAccess } from "./state";
import { requestConfirmDialog } from "~/confirmDialog";
import { toastManager } from "~/components/ui/toast";
import { post } from "./api";

export async function mutate(
  access: PolarisAccess,
  path: string,
  message: string,
  refresh: () => void,
  body: unknown = {},
  confirmation?: string,
) {
  if (confirmation && !(await requestConfirmDialog(confirmation, { variant: "destructive" })))
    return false;
  try {
    await post(access, path, body);
    toastManager.add({ type: "success", title: message });
    refresh();
    return true;
  } catch (cause) {
    toastManager.add({
      type: "error",
      title: "Polaris request failed",
      description: cause instanceof Error ? cause.message : String(cause),
    });
    return false;
  }
}
export function relativeTime(timestamp: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
