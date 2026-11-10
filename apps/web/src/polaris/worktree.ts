import type { EnvironmentId } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { request } from "./api";
import { readPolarisAccess } from "./state";

export async function mayRemoveWorktree(
  path: string,
  roots: readonly string[],
  isPolaris: () => Promise<boolean>,
) {
  const normalize = (value: string) =>
    normalizeProjectPathForComparison(value).replaceAll("\\", "/").replace(/\/+$/, "");
  const known = roots
    .filter((root) => root.startsWith("/") || /^[A-Za-z]:[\\/]/.test(root))
    .map(normalize)
    .filter((root) => root !== "" && !/^[a-z]:$/i.test(root));
  const target = normalize(path);
  if (target.split("/").includes("..")) return false;
  if (known.length) return known.some((root) => target.startsWith(`${root}/`));
  try {
    return !(await isPolaris());
  } catch {
    return true;
  }
}

export function managedRoots(
  config:
    | {
        keybindingsConfigPath: string;
        settings: { worktreesDirectory: string; previousWorktreesDirectories: readonly string[] };
      }
    | undefined,
) {
  if (!config) return [];
  const path = config.keybindingsConfigPath.replaceAll("\\", "/");
  const base = path.match(/^(.*)\/(?:userdata|dev)\/keybindings\.json$/)?.[1];
  if (!base) return [];
  const home = base.match(/^(.*)\/\.(?:t3|polaris-t3)$/)?.[1];
  const configured = [
    config.settings.worktreesDirectory,
    ...config.settings.previousWorktreesDirectories,
  ]
    .filter(Boolean)
    .map((root) => (root.startsWith("~/") && home ? `${home}/${root.slice(2)}` : root));
  if (configured.some((root) => root.startsWith("~"))) return [];
  return [`${base}/worktrees`, ...configured];
}

export async function guardWorktree(
  path: string | null,
  environmentId: EnvironmentId,
  config:
    | {
        keybindingsConfigPath: string;
        settings: { worktreesDirectory: string; previousWorktreesDirectories: readonly string[] };
      }
    | undefined,
) {
  if (!path) return null;
  const allowed = await mayRemoveWorktree(path, managedRoots(config), async () => {
    const access = await readPolarisAccess(environmentId);
    const result = await request<{ run: { workspaceId?: string } }>(
      access,
      `/v0/runs/resolve?cwd=${encodeURIComponent(path)}`,
    );
    return Boolean(result.run.workspaceId);
  });
  return allowed ? path : null;
}
