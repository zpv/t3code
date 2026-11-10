import { describe, expect, it } from "@effect/vitest";
import { accountPlan, chooseAccount, chooseSwitch, type Account } from "./accounts.ts";

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
  });
});
