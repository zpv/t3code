import type { ServerProvider } from "@t3tools/contracts";

export type Agent = "claude" | "codex" | "replay";
export type AccountConfig = {
  profile: string;
  label: string;
  default?: boolean;
  enabled?: boolean;
  tokenFile?: string;
  authHome?: string;
};
export type AccountsConfig = {
  autoSwitch?: boolean;
  switchAtPercent?: number;
  claude?: AccountConfig[];
  codex?: AccountConfig[];
  replay?: AccountConfig[];
};
export type Account = {
  id: string;
  agent: Agent;
  profile: string;
  label: string;
  enabled: boolean;
  signedIn: boolean | null;
  default: boolean;
  usage: ServerProvider["usageLimits"] | null;
};

export function accountPlan(config: AccountsConfig | undefined, replay = false) {
  return (["claude", "codex", ...(replay ? ["replay"] : [])] as Agent[]).flatMap((agent) => {
    const configured = config?.[agent] ?? [{ profile: "default", label: "Default", default: true }];
    if (
      configured.length === 0 ||
      configured.filter((a) => a.default).length !== 1 ||
      new Set(configured.map((a) => a.profile)).size !== configured.length
    )
      throw new Error(`Configure exactly one default and unique profiles for ${agent}`);
    return configured.map((account) => {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(account.profile))
        throw new Error(`Invalid ${agent} account profile`);
      return {
        ...account,
        agent,
        id: account.default
          ? agent === "claude"
            ? "claudeAgent"
            : agent === "replay"
              ? "devReplay"
              : "codex"
          : `${agent}-${account.profile}`,
      };
    });
  });
}

export function mostUsed(account: Account): number {
  return Math.max(0, ...(account.usage?.windows.map((window) => window.usedPercent) ?? []));
}

export function chooseAccount(
  accounts: readonly Account[],
  agent: Agent,
  profile: string | undefined,
  autoSwitch: boolean,
  threshold: number,
): Account | undefined {
  const candidates = accounts.filter((a) => a.agent === agent && a.enabled && a.signedIn !== false);
  if (profile) return candidates.find((a) => a.profile === profile);
  const primary = candidates.find((a) => a.default);
  if (!autoSwitch || (primary && mostUsed(primary) < threshold)) return primary;
  return (
    candidates
      .filter((a) => mostUsed(a) < threshold)
      .sort((a, b) => mostUsed(a) - mostUsed(b))[0] ?? primary
  );
}

export function chooseSwitch(
  accounts: readonly Account[],
  current: Account,
  attempted: readonly string[],
  explicitAt: number | undefined,
  now: number,
  threshold: number,
): Account | undefined {
  if (explicitAt !== undefined && now - explicitAt < 600_000) return undefined;
  return accounts
    .filter(
      (a) =>
        a.agent === current.agent &&
        a.id !== current.id &&
        !attempted.includes(a.id) &&
        a.enabled &&
        a.signedIn === true &&
        mostUsed(a) < threshold,
    )
    .sort((a, b) => mostUsed(a) - mostUsed(b))[0];
}
