// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The bridge owns account provisioning.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  type ServerConfig,
  type ProviderInstanceConfig,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import type { ConfigFile } from "./config.ts";
import type { State } from "./state.ts";
import type { Client } from "./t3Client.ts";

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

export type PlannedAccount = ReturnType<typeof accountPlan>[number];

export function retainedAccounts(
  previous: readonly PlannedAccount[],
  next: readonly PlannedAccount[],
  usedInstances: readonly string[],
): PlannedAccount[] {
  return previous
    .filter(
      (account) =>
        !next.some((item) => item.id === account.id) && usedInstances.includes(account.id),
    )
    .map((account) => ({ ...account, enabled: false }));
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

type AccountContext = {
  serverConfig: ServerConfig | undefined;
  file: ConfigFile;
  state: State;
  save: () => void;
  requireClient: () => Client;
  t3: (pathname: string, options?: RequestInit) => Promise<unknown>;
};
export function createAccountService(ctx: AccountContext) {
  const { state, save, requireClient, t3 } = ctx;
  const expandPath = (path: string) =>
    path.startsWith("~/") ? NodePath.join(NodeOS.homedir(), path.slice(2)) : NodePath.resolve(path);
  function accounts(): Account[] {
    return [
      ...accountPlan(ctx.file.accounts, process.env.POLARIS_T3_BRIDGE_ALLOW_REPLAY === "1"),
      ...(state.retiredAccounts ?? []),
    ].map((entry) => {
      const provider = ctx.serverConfig?.providers.find((p) => p.instanceId === entry.id);
      let signedIn: boolean | null =
        provider?.auth.status === "authenticated"
          ? true
          : provider?.auth.status === "unauthenticated"
            ? false
            : null;
      if (entry.tokenFile) {
        try {
          signedIn = NodeFS.readFileSync(expandPath(entry.tokenFile), "utf8").trim().length > 0;
        } catch {
          signedIn = false;
        }
      } else if (entry.authHome) {
        try {
          signedIn = NodeFS.lstatSync(
            NodePath.join(expandPath(entry.authHome), "auth.json"),
          ).isFile();
        } catch {
          signedIn = false;
        }
      }
      return {
        id: entry.id,
        agent: entry.agent,
        profile: entry.profile,
        label: entry.label,
        enabled: entry.enabled !== false && (provider?.enabled ?? true),
        signedIn,
        default: entry.default === true,
        usage: provider?.usageLimits ?? null,
      };
    });
  }
  async function refreshUsage() {
    if (!ctx.serverConfig) return;
    if (accounts().some((a) => a.usage && Date.now() - Date.parse(a.usage.checkedAt) > 300_000)) {
      const result = await Effect.runPromise(
        requireClient()["server.refreshProviders"]({ fresh: true }),
      );
      ctx.serverConfig = { ...ctx.serverConfig, providers: result.providers };
    }
  }
  async function provision() {
    if (!ctx.serverConfig) return;
    const plan = accountPlan(ctx.file.accounts, process.env.POLARIS_T3_BRIDGE_ALLOW_REPLAY === "1");
    const shell = (await t3("/api/orchestration/shell")) as OrchestrationV2ShellSnapshot;
    const used = [...shell.threads, ...shell.archivedThreads].map(
      (thread) => thread.providerInstanceId,
    );
    state.retiredAccounts = retainedAccounts(state.knownAccounts ?? [], plan, used);
    state.knownAccounts = [...plan, ...state.retiredAccounts];
    save();
    for (const id of state.ownedInstances ?? []) {
      if (plan.some((account) => account.id === id) || used.includes(ProviderInstanceId.make(id)))
        continue;
      const settings = await Effect.runPromise(
        requireClient()["server.updateSettings"]({
          patch: {},
          providerInstanceMutation: {
            operation: "remove",
            instanceId: ProviderInstanceId.make(id),
          },
        }),
      );
      ctx.serverConfig = { ...ctx.serverConfig, settings };
      state.ownedInstances = (state.ownedInstances ?? []).filter((owned) => owned !== id);
      if (state.briefArgs) delete state.briefArgs[id];
      save();
    }
    if (
      !ctx.file.accounts &&
      !ctx.file.agentBriefFile &&
      !Object.keys(state.briefArgs ?? {}).length
    )
      return;
    for (const account of plan) {
      const baseId =
        account.agent === "claude"
          ? "claudeAgent"
          : account.agent === "codex"
            ? "codex"
            : "devReplay";
      const base = ctx.serverConfig.settings.providerInstances[ProviderInstanceId.make(baseId)] ?? {
        driver: ProviderDriverKind.make(baseId),
        config: {},
      };
      const existing =
        ctx.serverConfig.settings.providerInstances[ProviderInstanceId.make(account.id)];
      const baseConfig = (base.config ?? {}) as Record<string, unknown>;
      const existingConfig = (existing?.config ?? {}) as Record<string, unknown>;
      const config: Record<string, unknown> = { ...baseConfig, ...existingConfig };
      if (account.agent === "claude") config.homePath = baseConfig.homePath ?? "";
      if (account.agent === "codex" && !account.default) {
        config.homePath = baseConfig.homePath ?? "";
        config.shadowHomePath = account.authHome ? expandPath(account.authHome) : "";
      }
      const previousBrief = state.briefArgs?.[account.id];
      let launchArgs = typeof config.launchArgs === "string" ? config.launchArgs : "";
      if (!existing && state.briefArgs?.[baseId])
        launchArgs = launchArgs.replace(state.briefArgs[baseId], "").trim();
      if (previousBrief) launchArgs = launchArgs.replace(previousBrief, "").trim();
      let newBrief: string | undefined;
      if (ctx.file.agentBriefFile && NodeFS.existsSync(expandPath(ctx.file.agentBriefFile))) {
        const briefPath = expandPath(ctx.file.agentBriefFile);
        if (account.agent === "claude")
          newBrief = `--append-system-prompt-file ${JSON.stringify(briefPath)}`;
        else if (account.agent === "codex")
          newBrief = `-c ${JSON.stringify(`developer_instructions=${JSON.stringify(NodeFS.readFileSync(briefPath, "utf8"))}`)}`;
      }
      config.launchArgs = [launchArgs, newBrief].filter(Boolean).join(" ");
      let environment = [...(existing?.environment ?? [])].filter(
        (v) => v.name !== "CLAUDE_CODE_OAUTH_TOKEN",
      );
      if (account.tokenFile) {
        let tokenValue = "";
        try {
          tokenValue = NodeFS.readFileSync(expandPath(account.tokenFile), "utf8").trim();
        } catch {}
        if (tokenValue)
          environment.push({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: tokenValue, sensitive: true });
      } else if (account.default) environment = [...(existing?.environment ?? [])];
      const instance: ProviderInstanceConfig = {
        ...base,
        ...existing,
        displayName: account.label,
        enabled: account.enabled !== false,
        config,
        environment,
      };
      try {
        const settings = await Effect.runPromise(
          requireClient()["server.updateSettings"]({
            patch: {},
            providerInstanceMutation: {
              operation: "upsert",
              instanceId: ProviderInstanceId.make(account.id),
              instance,
            },
          }),
        );
        ctx.serverConfig = { ...ctx.serverConfig, settings };
        if (!existing && !account.default) {
          state.ownedInstances = [...new Set([...(state.ownedInstances ?? []), account.id])];
        }
        state.briefArgs ??= {};
        if (newBrief) state.briefArgs[account.id] = newBrief;
        else delete state.briefArgs[account.id];
        save();
      } catch {
        throw new Error(`Could not provision ${account.agent} account ${account.profile}`);
      }
    }
    ctx.serverConfig = await Effect.runPromise(requireClient()["server.getConfig"]({}));
  }

  return { accounts, refreshUsage, provision };
}
