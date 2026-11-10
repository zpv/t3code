import { describe, expect, it } from "vite-plus/test";
import { managedRoots, mayRemoveWorktree } from "./worktree";

describe("worktree ownership", () => {
  it("includes the default and previous directories from server config", () => {
    expect(
      managedRoots({
        keybindingsConfigPath: "/home/user/.t3/userdata/keybindings.json",
        settings: { worktreesDirectory: "~/custom", previousWorktreesDirectories: ["/old"] },
      }),
    ).toEqual(["/home/user/.t3/worktrees", "/home/user/custom", "/old"]);
    expect(
      managedRoots({
        keybindingsConfigPath: "/custom/dev/keybindings.json",
        settings: { worktreesDirectory: "~/custom", previousWorktreesDirectories: [] },
      }),
    ).toEqual([]);
  });
  it("uses configured roots and falls back to Polaris when the default is unknown", async () => {
    const polaris = async () => true;
    expect(await mayRemoveWorktree("/managed/a", ["/managed", "/old"], polaris)).toBe(true);
    expect(await mayRemoveWorktree("/old/a", ["/managed", "/old"], polaris)).toBe(true);
    expect(await mayRemoveWorktree("/managed-other/a", ["/managed"], polaris)).toBe(false);
    expect(await mayRemoveWorktree("/external/a", [], polaris)).toBe(false);
    expect(await mayRemoveWorktree("/external/a", [], async () => false)).toBe(true);
    expect(
      await mayRemoveWorktree("/external/a", [], async () => {
        throw Error("offline");
      }),
    ).toBe(true);
  });
});
