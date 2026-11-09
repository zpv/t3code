// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off -- This live smoke owns its processes and network lifecycle.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import { readProjection } from "./smoke-rpc.ts";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "polaris-import-"));
const home = NodePath.join(base, "t3");
const repo = NodePath.join(base, "repo");
const worktree = NodePath.join(base, "worktree");
NodeFS.mkdirSync(repo);
NodeChildProcess.execFileSync("git", ["init", "-q", repo]);
NodeChildProcess.execFileSync("git", [
  "-C",
  repo,
  "-c",
  "user.name=Smoke",
  "-c",
  "user.email=smoke@localhost",
  "commit",
  "--allow-empty",
  "-qm",
  "init",
]);
const records: { path: string; body: Record<string, unknown> }[] = [];
const fake = NodeHttp.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  records.push({ path: req.url!, body });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify(
      req.url === "/v0/t3/runs/adopt" ? { run: { id: `adopt-${body.threadId}` } } : { ok: true },
    ),
  );
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakeAddress = fake.address();
NodeAssert.ok(fakeAddress && typeof fakeAddress !== "string");
const reserve = NodeHttp.createServer();
await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const addr = reserve.address();
NodeAssert.ok(addr && typeof addr !== "string");
const bridgePort = addr.port;
await new Promise<void>((resolve) => reserve.close(() => resolve()));
const shimDir = NodePath.join(base, "bin");
NodeFS.mkdirSync(shimDir);
const runnerPidFile = NodePath.join(base, "dev-runner.pid");
NodeFS.writeFileSync(
  NodePath.join(shimDir, "node"),
  `#!/bin/sh
if [ "$1" = "scripts/dev-runner.ts" ]; then printf '%s' "$$" > "$SMOKE_RUNNER_PID_FILE"; fi
exec "$SMOKE_REAL_NODE" "$@"
`,
  { mode: 0o755 },
);
const children: NodeChildProcess.ChildProcess[] = [];
let log = "";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  label: string,
  fn: () => Promise<T | undefined>,
  timeout = 90000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value !== undefined) return value;
    await pause(250);
  }
  throw new Error(
    `Timed out: ${label}\n${log.slice(-6000).replace(/pairingUrl: \S+/g, "pairingUrl: [REDACTED]")}`,
  );
}
function spawnTracked(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = NodeChildProcess.spawn(command, args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout?.on("data", (x) => {
    log += x.toString();
  });
  child.stderr?.on("data", (x) => {
    log += x.toString();
  });
  child.on("error", (e) => {
    log += String(e);
  });
  return child;
}
async function json(url: string, body?: object) {
  const res = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = (await res.json()) as {
    threadId: string;
    messageCount: number;
    output: string;
    projects: { id: string; workspaceRoot: string }[];
  };
  NodeAssert.ok(res.ok, `${url}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}
NodeChildProcess.execFileSync("git", [
  "-C",
  repo,
  "worktree",
  "add",
  "-qb",
  "smoke-import",
  worktree,
]);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  T3CODE_TELEMETRY_ENABLED: "false",
  T3CODE_DISABLE_AUTO_UPDATE: "true",
  T3CODE_DEV_SEED: "0",
  PATH: `${shimDir}:${process.env.PATH}`,
  SMOKE_RUNNER_PID_FILE: runnerPidFile,
  SMOKE_REAL_NODE: process.execPath,
};
delete env.CLAUDECODE;
const prompt = "Remember the code word: marmalade. Reply OK.";
try {
  const fixtures: { agent: string; sessionId: string; model: string }[] = [];
  const failures: string[] = [];
  let initialClaude: unknown;
  let initialCodex: unknown;
  try {
    const output = NodeChildProcess.execFileSync(
      "claude",
      ["-p", "--model", "haiku", "--output-format", "json", prompt],
      { cwd: worktree, env, encoding: "utf8", timeout: 240000 },
    );
    const result = JSON.parse(output) as {
      session_id: string;
      total_cost_usd?: number;
      usage?: unknown;
    };
    NodeAssert.ok(result.session_id, "Claude did not return a session ID");
    fixtures.push({ agent: "claude", sessionId: result.session_id, model: "claude-haiku-5-5" });
    initialClaude = { cost: result.total_cost_usd, usage: result.usage };
  } catch (error) {
    failures.push(`Claude session creation: ${String(error)}`);
  }
  try {
    const output = NodeChildProcess.execFileSync(
      "codex",
      ["exec", "--json", "-m", "gpt-6-luna", prompt],
      {
        cwd: worktree,
        env,
        encoding: "utf8",
        timeout: 240000,
      },
    );
    const events = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const result = events.find((event) => event.type === "thread.started");
    NodeAssert.ok(result?.thread_id, "Codex did not return a session ID");
    fixtures.push({ agent: "codex", sessionId: result.thread_id, model: "gpt-6-luna" });
    initialCodex = events
      .filter((event) => event.type === "turn.completed")
      .map((event) => event.usage);
  } catch (error) {
    failures.push(`Codex session creation: ${String(error)}`);
  }
  spawnTracked("vp", ["run", "dev", "--no-seed", "--home-dir", home], env);
  const serverPort = await until("dev-runner port", async () => /serverPort=(\d+)/.exec(log)?.[1]);
  const origin = `http://127.0.0.1:${serverPort}`;
  await until("server", async () => {
    try {
      return (await fetch(`${origin}/.well-known/t3/environment`)).ok ? true : undefined;
    } catch {
      return undefined;
    }
  });
  const token = NodeChildProcess.execFileSync(
    process.execPath,
    ["apps/server/src/bin.ts", "auth", "session", "issue", "--base-dir", home, "--token-only"],
    { cwd: root, env, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .at(-1)!;
  const bridgeEnv = {
    ...env,
    T3_ORIGIN: origin,
    T3_TOKEN: token,
    POLARIS_SERVER: `http://127.0.0.1:${fakeAddress.port}`,
    POLARIS_T3_BRIDGE_PORT: String(bridgePort),
    POLARIS_T3_BRIDGE_STATE: NodePath.join(base, "state.json"),
    POLARIS_T3_BRIDGE_CONFIG: NodePath.join(base, "config.json"),
  };
  NodeFS.writeFileSync(
    bridgeEnv.POLARIS_T3_BRIDGE_CONFIG,
    JSON.stringify({ defaults: { phoneNotifications: false } }),
  );
  spawnTracked(process.execPath, ["apps/polaris-bridge/src/bin.ts"], bridgeEnv);
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`;
  await until("bridge connected", async () => {
    try {
      return (
        (await (await fetch(`${bridgeOrigin}/v1/health`)).json()) as { t3: { connected: boolean } }
      ).t3.connected
        ? true
        : undefined;
    } catch {
      return undefined;
    }
  });
  const results = [];
  for (const item of fixtures) {
    try {
      const runId = `run_${NodeCrypto.randomUUID()}`;
      const created = await json(`${bridgeOrigin}/v1/threads/import`, {
        runId,
        agent: item.agent,
        sessionId: item.sessionId,
        title: `Import ${item.agent}`,
        repoPath: repo,
        worktreePath: worktree,
        branch: "smoke-import",
        model: item.model,
        settled: true,
      });
      NodeAssert.ok(
        (await json(`${bridgeOrigin}/v1/threads/${created.threadId}/snapshot`)).output.includes(
          prompt,
        ),
        `${item.agent} imported history is missing`,
      );
      await json(`${bridgeOrigin}/v1/threads/${created.threadId}/input`, {
        input: "What is the code word? Reply with only the word.",
      });
      const completed = await until(
        `${item.agent} completion`,
        async () =>
          records.find(
            (r) => r.path === `/v0/runs/${runId}/events` && r.body.type === "assistant.completed",
          ),
        240000,
      );
      const text = (completed.body.payload as { text: string }).text;
      NodeAssert.match(text, /marmalade/i);
      const projection = await readProjection(origin, token, created.threadId);
      const handoffs = projection.contextHandoffs.map((h) => ({
        strategy: h.strategy,
        status: h.status,
        delivery: h.delivery,
      }));
      results.push({
        agent: item.agent,
        answer: text,
        messageCount: created.messageCount,
        handoffs,
        usage: projection.providerTurns.map((turn) => ({
          tokenUsage: turn.tokenUsage,
          turnTokenUsage: turn.turnTokenUsage,
        })),
      });
    } catch (error) {
      failures.push(`${item.agent} import or resume: ${String(error)}`);
    }
  }
  console.log(
    JSON.stringify(
      {
        results,
        initialClaude,
        initialCodex,
        failures,
      },
      null,
      2,
    ),
  );
  if (failures.length) throw new Error(failures.join("; "));
  console.log("PASS native worktree import and resume");
} finally {
  if (NodeFS.existsSync(runnerPidFile)) {
    const runnerPid = Number(NodeFS.readFileSync(runnerPidFile, "utf8"));
    if (Number.isSafeInteger(runnerPid) && runnerPid > 0) {
      try {
        process.kill(runnerPid, "SIGINT");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
  for (const child of children.reverse())
    if (child.exitCode === null && child.signalCode === null && child.spawnfile !== "vp")
      child.kill("SIGINT");
  await Promise.all(
    children.map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => child.once("exit", () => resolve())),
    ),
  );
  await new Promise<void>((resolve) => fake.close(() => resolve()));
  NodeFS.writeFileSync(
    NodePath.join(base, "smoke.log"),
    log.replace(/pairingUrl: \S+/g, "pairingUrl: [REDACTED]"),
  );
  console.log(`Evidence: ${base}`);
}

process.exit(0);
