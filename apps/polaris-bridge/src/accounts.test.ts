import { describe, expect, it } from "@effect/vitest";
import {
  accountPlan,
  chooseAccount,
  chooseSwitch,
  retainedAccounts,
  type Account,
} from "./accounts.ts";

describe("account decisions", () => {
  it("plans built-in and account instances without credentials", () => {
    const plan = accountPlan({
      claude: [
        { profile: "main", label: "Main", default: true },
        { profile: "second", label: "Second", tokenFile: "/tmp/token" },
      ],
    });
    expect(plan.map((a) => a.id)).toEqual(["claudeAgent", "claude-second", "codex"]);
    expect(JSON.stringify(plan)).not.toContain("actual-secret");
  });
  it("honors explicit choice and switches only to eligible headroom", () => {
    const a = (profile: string, used: number, extra: Partial<Account> = {}): Account => ({
      id: profile,
      agent: "claude",
      profile,
      label: profile,
      enabled: true,
      signedIn: true,
      default: profile === "main",
      usage: {
        checkedAt: "2026-01-01T00:00:00Z" as never,
        windows: [{ id: "w", kind: "session", label: "5h", usedPercent: used }],
      },
      ...extra,
    });
    const accounts = [
      a("main", 99),
      a("second", 30),
      a("disabled", 1, { enabled: false }),
      a("out", 2, { signedIn: false }),
    ];
    expect(chooseAccount(accounts, "claude", undefined, true, 97)?.profile).toBe("second");
    expect(chooseSwitch(accounts, accounts[0]!, [], undefined, 1_000_000, 97)?.profile).toBe(
      "second",
    );
    expect(chooseSwitch(accounts, accounts[0]!, [], 900_000, 1_000_000, 97)).toBeUndefined();
    expect(
      chooseSwitch(accounts, accounts[0]!, ["second"], undefined, 1_000_000, 97),
    ).toBeUndefined();
    expect(chooseAccount(accounts, "claude", "main", true, 97)?.profile).toBe("main");
    expect(chooseAccount(accounts, "claude", undefined, false, 97)?.profile).toBe("main");
    expect(
      chooseAccount([a("main", 99), a("second", 98)], "claude", undefined, true, 97)?.profile,
    ).toBe("main");
    const limited = [a("main", 99), a("second", 98)];
    expect(chooseSwitch(limited, limited[0]!, [], undefined, 1_000_000, 97)).toBeUndefined();
  });
  it("retains removed accounts while a thread still uses them", () => {
    const previous = accountPlan({
      claude: [
        { profile: "main", label: "Main", default: true },
        { profile: "second", label: "Second" },
      ],
    });
    const next = accountPlan(undefined);
    expect(
      retainedAccounts(previous, next, ["claude-second"]).map((a) => [a.id, a.enabled]),
    ).toEqual([["claude-second", false]]);
    expect(retainedAccounts(previous, next, [])).toEqual([]);
  });
});

it("retries failed provisioning and retains an account used by a thread after reload", async () => {
  const { Effect } = await import("effect");
  const { createAccountService } = await import("./accounts.ts");
  const state: import("./state.ts").State = { threads: {}, ownedInstances: ["claude-second"] };
  let file: import("./config.ts").ConfigFile = {
    accounts: {
      claude: [
        { profile: "main", label: "Main", default: true },
        { profile: "second", label: "Second" },
      ],
    },
  };
  let config = {
    settings: {
      providerInstances: {
        claudeAgent: { driver: "claudeAgent", config: {} },
        "claude-second": { driver: "claudeAgent", config: {} },
        codex: { driver: "codex", config: {} },
      },
    },
    providers: [],
  } as unknown as import("@t3tools/contracts").ServerConfig;
  let fail = true;
  const removed: string[] = [];
  const client = {
    "server.updateSettings": ({
      providerInstanceMutation,
    }: {
      providerInstanceMutation: { operation: string; instanceId: string; instance?: unknown };
    }) => {
      if (fail) {
        fail = false;
        return Effect.fail("temporary failure");
      }
      if (providerInstanceMutation.operation === "remove")
        removed.push(providerInstanceMutation.instanceId);
      return Effect.succeed(config.settings);
    },
    "server.getConfig": () => Effect.succeed(config),
  } as unknown as import("./t3Client.ts").Client;
  const service = createAccountService({
    get file() {
      return file;
    },
    get serverConfig() {
      return config;
    },
    set serverConfig(value) {
      config = value!;
    },
    state,
    save: () => {},
    requireClient: () => client,
    t3: async () => ({ threads: [{ providerInstanceId: "claude-second" }], archivedThreads: [] }),
  });
  await expect(service.provision()).rejects.toThrow("Could not provision");
  await service.provision();
  file = { accounts: { claude: [{ profile: "main", label: "Main", default: true }] } };
  await service.provision();
  expect(removed).not.toContain("claude-second");
  expect(service.accounts().find((account) => account.id === "claude-second")?.enabled).toBe(false);
  expect(state.ownedInstances).toContain("claude-second");
});
