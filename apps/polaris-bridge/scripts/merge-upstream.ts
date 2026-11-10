// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- This tool coordinates git and verification commands.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const generated = new Set(["pnpm-lock.yaml", "apps/web/src/routeTree.gen.ts"]);
export function classifyConflicts(files: string[]) {
  return {
    generated: files.filter((file) => generated.has(file)),
    other: files.filter((file) => !generated.has(file)),
  };
}
export function summary(count: number, dryRun = false) {
  return dryRun
    ? `would merge ${count} upstream commits`
    : `merged ${count} upstream commits; all checks passed`;
}

function command(program: string, args: string[]) {
  const result = NodeChildProcess.spawnSync(program, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, T3CODE_TELEMETRY_ENABLED: "false", GIT_EDITOR: "true" },
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    output:
      `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`.trim(),
  };
}
function main() {
  const flags = process.argv.slice(2);
  const fail = (message: string, code: number, output = "") => {
    if (output) console.error(output.split("\n").slice(-20).join("\n"));
    console.error(message);
    process.exitCode = code;
  };
  if (flags.some((flag) => !["--dry-run", "--no-push"].includes(flag)))
    return fail("unknown option", 1);
  const root = command("git", ["rev-parse", "--show-toplevel"]);
  if (!root.ok || NodePath.resolve(root.output) !== process.cwd())
    return fail("run from the repository root", 1);
  const status = command("git", ["status", "--porcelain"]);
  if (!status.ok || status.output) return fail("refusing to merge: working tree is dirty", 1);
  const branch = command("git", ["branch", "--show-current"]);
  if (!branch.ok || branch.output !== "polaris")
    return fail("refusing to merge: current branch is not polaris", 1);
  const pre = command("git", ["rev-parse", "HEAD"]);
  if (!pre.ok) return fail("could not read current commit", 1, pre.output);
  for (const args of [
    ["fetch", "upstream"],
    ["fetch", "upstream", "main:main"],
  ]) {
    const result = command("git", args);
    if (!result.ok) return fail(`failed: git ${args.join(" ")}`, 1, result.output);
  }
  const countResult = command("git", ["rev-list", "--count", "HEAD..main"]);
  if (!countResult.ok) return fail("could not count upstream commits", 1, countResult.output);
  const count = Number(countResult.output);
  if (count === 0) return console.log("up to date");
  if (flags.includes("--dry-run")) return console.log(summary(count, true));
  const merge = command("git", ["merge", "--no-edit", "main"]);
  if (!merge.ok) {
    const conflicts = command("git", ["diff", "--name-only", "--diff-filter=U"]);
    const files = conflicts.output ? conflicts.output.split("\n") : [];
    const classified = classifyConflicts(files);
    if (!conflicts.ok || !files.length || classified.other.length) {
      command("git", ["merge", "--abort"]);
      return fail(
        `merge aborted; conflicted files: ${files.join(", ") || "none"}`,
        2,
        !files.length ? merge.output : "",
      );
    }
    const restore = command("git", ["checkout", "--theirs", "--", ...classified.generated]);
    if (!restore.ok) {
      command("git", ["merge", "--abort"]);
      return fail("failed: resolve generated files", 3, restore.output);
    }
    const install = command("vp", ["i"]);
    const build =
      install.ok && classified.generated.includes("apps/web/src/routeTree.gen.ts")
        ? command("vp", ["run", "--filter", "@t3tools/web", "build"])
        : { ok: true, output: "" };
    if (!install.ok || !build.ok) {
      command("git", ["merge", "--abort"]);
      return fail(
        `failed: ${install.ok ? "web build" : "vp i"}`,
        3,
        install.ok ? build.output : install.output,
      );
    }
    const add = command("git", ["add", ...classified.generated]);
    const finish = add.ok ? command("git", ["merge", "--continue"]) : add;
    if (!finish.ok) {
      command("git", ["merge", "--abort"]);
      return fail("failed: complete merge", 3, finish.output);
    }
  }
  const steps: [string, string, string[]][] = [
    ["vp i", "vp", ["i"]],
    ["check seams", "node", ["apps/polaris-bridge/scripts/check-seams.ts"]],
    ...["@t3tools/polaris-bridge", "t3", "@t3tools/web"].map((pkg): [string, string, string[]] => [
      `${pkg} typecheck`,
      "vp",
      ["run", "--filter", pkg, "typecheck"],
    ]),
    ["bridge tests", "vp", ["test", "run", "apps/polaris-bridge/src"]],
    ["server Polaris tests", "vp", ["test", "run", "apps/server/src/polaris"]],
    ["web Polaris tests", "vp", ["test", "run", "apps/web/src/polaris"]],
    ["bridge smoke", "node", ["apps/polaris-bridge/scripts/smoke.ts"]],
  ];
  for (const [name, program, args] of steps) {
    const result = command(program, args);
    if (!result.ok) {
      const reset = command("git", ["reset", "--hard", pre.output]);
      return fail(
        `failed: ${name}${reset.ok ? "; merge rolled back" : "; rollback failed"}`,
        3,
        `${result.output}${reset.ok ? "" : `\n${reset.output}`}`,
      );
    }
  }
  if (!flags.includes("--no-push")) {
    const push = command("git", ["push", "origin", "main", "polaris"]);
    if (!push.ok) return fail("checks passed; push failed", 3, push.output);
  }
  console.log(summary(count));
}
if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
)
  main();
