// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off -- The bridge reads its own config.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { AccountsConfig } from "./accounts.ts";

export type ConfigFile = {
  T3_ORIGIN?: string;
  T3_TOKEN?: string;
  POLARIS_SERVER?: string;
  POLARIS_T3_BRIDGE_PORT?: string | number;
  POLARIS_T3_BRIDGE_TOKEN?: string;
  POLARIS_T3_BRIDGE_STATE?: string;
  publicOrigin?: string;
  accounts?: AccountsConfig;
  agentBriefFile?: string;
  instances?: unknown;
  defaults?: {
    claude?: { model?: string | null; effort?: string | null };
    codex?: { model?: string | null; effort?: string | null };
    runtimeMode?: "full-access" | "approval-required";
    phoneNotifications?: boolean;
  };
};
export const configPath =
  process.env.POLARIS_T3_BRIDGE_CONFIG ??
  NodePath.join(NodeOS.homedir(), ".polaris/t3-bridge.json");
export function readConfig(): ConfigFile {
  const file: ConfigFile = NodeFS.existsSync(configPath)
    ? JSON.parse(NodeFS.readFileSync(configPath, "utf8"))
    : {};
  if (file.instances !== undefined)
    throw new Error("The instances key is no longer supported; use accounts");
  return file;
}
