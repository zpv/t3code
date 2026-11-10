// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off -- The bridge owns its local state file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Event } from "./logic.ts";
import type { PlannedAccount } from "./accounts.ts";

export type Entry = {
  runId: string;
  events: string[];
  dispatched: string[];
  cursor?: number;
  state?: string;
  outbox: Event[];
  pendingCreation?: "create" | "import";
  freshContext?: boolean;
  answers?: { requestId: string; values: Record<string, string> };
  accountChangedAt?: number;
  modelFallback?: { requested: string; used: string };
  switchRuns?: string[];
  switchAccounts?: string[];
  switching?: {
    from: string;
    to: string;
    failedRunId: string;
    moveCommandId: string;
    messageCommandId: string;
    messageId: string;
    event: Event;
  };
};
export type State = {
  threads: Record<string, Entry>;
  shellCursor?: number;
  briefArgs?: Record<string, string>;
  ownedInstances?: string[];
  knownAccounts?: PlannedAccount[];
  retiredAccounts?: PlannedAccount[];
};
export function openState(statePath: string) {
  const state: State = NodeFS.existsSync(statePath)
    ? JSON.parse(NodeFS.readFileSync(statePath, "utf8"))
    : { threads: {} };
  function save() {
    NodeFS.mkdirSync(NodePath.dirname(statePath), { recursive: true });
    const temp = `${statePath}.${process.pid}.tmp`;
    NodeFS.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    NodeFS.renameSync(temp, statePath);
  }
  return { state, save };
}
