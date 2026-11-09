// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off -- This live smoke owns its processes and network lifecycle.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import { createDirect } from "./smoke-rpc.ts";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "polaris-smoke-"));
const home = NodePath.join(base, "t3");
const repo = NodePath.join(base, "repo");
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
try {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_DISABLE_AUTO_UPDATE: "true",
    T3CODE_DEV_SEED: "0",
    PATH: `${shimDir}:${process.env.PATH}`,
    SMOKE_RUNNER_PID_FILE: runnerPidFile,
    SMOKE_REAL_NODE: process.execPath,
  };
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
  const directUpgrade = await new Promise<number>((resolve, reject) => {
    const req = NodeHttp.request(`${origin}/ws?orchestrationProtocol=2`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": NodeCrypto.randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    });
    req.on("upgrade", (response, socket) => {
      resolve(response.statusCode ?? 0);
      socket.destroy();
    });
    req.on("response", (response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    req.on("error", reject);
    req.end();
  });
  console.log(`Bearer-only WebSocket upgrade: ${directUpgrade}`);
  const bridgeEnv = {
    ...env,
    T3_ORIGIN: origin,
    T3_TOKEN: token,
    POLARIS_SERVER: `http://127.0.0.1:${fakeAddress.port}`,
    POLARIS_T3_BRIDGE_PORT: String(bridgePort),
    POLARIS_T3_BRIDGE_STATE: NodePath.join(base, "state.json"),
    POLARIS_T3_BRIDGE_ALLOW_REPLAY: "1",
    POLARIS_T3_BRIDGE_CONFIG: NodePath.join(base, "config.json"),
  };
  NodeFS.writeFileSync(
    bridgeEnv.POLARIS_T3_BRIDGE_CONFIG,
    JSON.stringify({ defaults: { phoneNotifications: false } }),
  );
  let bridge = spawnTracked(process.execPath, ["apps/polaris-bridge/src/bin.ts"], bridgeEnv);
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
  const runId = `run_${NodeCrypto.randomUUID()}`;
  const created = await json(`${bridgeOrigin}/v1/threads`, {
    runId,
    agent: "replay",
    title: "Smoke",
    repoPath: repo,
    model: "showcase",
  });
  const repeat = await json(`${bridgeOrigin}/v1/threads`, {
    runId,
    agent: "replay",
    title: "Smoke",
    repoPath: repo,
    model: "showcase",
  });
  NodeAssert.equal(repeat.threadId, created.threadId);
  await json(`${bridgeOrigin}/v1/threads/${created.threadId}/input`, { input: "hello" });
  const completed = await until("assistant completion", async () =>
    records.find(
      (r) => r.path === `/v0/runs/${runId}/events` && r.body.type === "assistant.completed",
    ),
  );
  NodeAssert.ok((completed.body.payload as { text: string }).text.length > 0);
  NodeAssert.ok(
    (await json(`${bridgeOrigin}/v1/threads/${created.threadId}/snapshot`)).output.length > 0,
  );
  bridge.kill("SIGTERM");
  await new Promise<void>((resolve) => bridge.once("exit", () => resolve()));
  const retryRun = `run_${NodeCrypto.randomUUID()}`;
  const savedState = JSON.parse(NodeFS.readFileSync(bridgeEnv.POLARIS_T3_BRIDGE_STATE, "utf8"));
  savedState.threads[`polaris-${retryRun}`] = {
    runId: retryRun,
    events: [],
    dispatched: [],
    outbox: [],
    pendingCreation: "create",
  };
  NodeFS.writeFileSync(bridgeEnv.POLARIS_T3_BRIDGE_STATE, JSON.stringify(savedState));
  bridge = spawnTracked(process.execPath, ["apps/polaris-bridge/src/bin.ts"], bridgeEnv);
  await until("bridge reconnected", async () => {
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
  const retried = await json(`${bridgeOrigin}/v1/threads`, {
    runId: retryRun,
    agent: "replay",
    title: "Recovered create",
    repoPath: repo,
    model: "showcase",
  });
  NodeAssert.equal(retried.threadId, `polaris-${retryRun}`);
  const shell = await json(`${origin}/api/orchestration/shell`).catch(async () => {
    const res = await fetch(`${origin}/api/orchestration/shell`, {
      headers: { Authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
    });
    NodeAssert.ok(res.ok);
    return (await res.json()) as {
      threadId: string;
      messageCount: number;
      output: string;
      projects: { id: string; workspaceRoot: string }[];
    };
  });
  const project = shell.projects.find(
    (p: { workspaceRoot: string }) => p.workspaceRoot === NodeFS.realpathSync(repo),
  );
  NodeAssert.ok(project);
  const direct = await createDirect(origin, token, project.id);
  await until("direct thread adopted", async () =>
    records.find((r) => r.path === "/v0/t3/runs/adopt" && r.body.threadId === direct),
  );
  await pause(1500);
  NodeAssert.equal(
    records.filter(
      (r) => r.path === `/v0/runs/${runId}/events` && r.body.type === "assistant.completed",
    ).length,
    1,
  );
  NodeAssert.equal(
    records.filter((r) => r.path === "/v0/t3/runs/adopt" && r.body.threadId === direct).length,
    1,
  );
  console.log(
    "PASS replay completion, snapshot, restart deduplication, and direct-thread adoption",
  );
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
