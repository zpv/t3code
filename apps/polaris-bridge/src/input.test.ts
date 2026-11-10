import { describe, expect, it } from "@effect/vitest";
import { interpretInput } from "./input.ts";

describe("interpretInput", () => {
  it("applies the contract table in order", () => {
    const q = { kind: "question" as const, options: ["one", "two"] };
    const a = { kind: "approval" as const };
    for (const key of ["$esc", "$cc", "$ctrl-c", "$enter $esc"])
      expect(interpretInput(key, q)).toEqual({ type: "interrupt" });
    expect(interpretInput("$enter $tab", null)).toEqual({
      type: "refuse",
      reason: "T3 threads have no terminal keys",
    });
    expect(interpretInput("2", q)).toEqual({ type: "question", text: "2", option: 2 });
    expect(interpretInput("99", q).type).toBe("refuse");
    expect(interpretInput("/model foo", q)).toEqual({
      type: "question",
      text: "/model foo",
      option: null,
    });
    for (const text of ["y", "yes", "approve", "1"])
      expect(interpretInput(text, a)).toEqual({ type: "approval", approved: true });
    for (const text of ["n", "no", "deny", "2"])
      expect(interpretInput(text, a)).toEqual({ type: "approval", approved: false });
    expect(interpretInput("/model foo", null)).toEqual({ type: "model", value: "foo" });
    expect(interpretInput("/effort high", null)).toEqual({ type: "effort", value: "high" });
    for (const command of ["model", "effort", "account", "status", "usage", "context", "clear"]) {
      expect(interpretInput(`/${command}`, null)).toEqual({ type: command, value: "" });
    }
    expect(interpretInput("/account second", null)).toEqual({ type: "account", value: "second" });
    for (const text of ["/compact", "/goal finish", "$skill do it"])
      expect(interpretInput(text, null)).toEqual({ type: "message", text });
    expect(interpretInput("hello", null)).toEqual({ type: "message", text: "hello" });
  });
});
