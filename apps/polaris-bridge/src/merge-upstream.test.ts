import { describe, expect, it } from "@effect/vitest";
import { classifyConflicts, summary } from "../scripts/merge-upstream.ts";

describe("upstream merge", () => {
  it("accepts only generated conflicts and writes concise summaries", () => {
    expect(
      classifyConflicts([
        "pnpm-lock.yaml",
        "apps/web/src/routeTree.gen.ts",
        "apps/web/src/other.ts",
      ]),
    ).toEqual({
      generated: ["pnpm-lock.yaml", "apps/web/src/routeTree.gen.ts"],
      other: ["apps/web/src/other.ts"],
    });
    expect(summary(12)).toBe("merged 12 upstream commits; all checks passed");
    expect(summary(12, true)).toBe("would merge 12 upstream commits");
  });
});
