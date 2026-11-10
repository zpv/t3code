// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off globalJsonInEffect:off globalRandom:off extendsNativeError:off -- This process owns its HTTP and reconnect lifecycle.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
  type ServerConfig,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import { publicOrigin } from "./logic.ts";
import { createEventService } from "./events.ts";
import { turnState, createThreadService } from "./threads.ts";
import { createInputService } from "./input.ts";
import { t3Request, runConnection, type Client } from "./t3Client.ts";
import { createRoute } from "./http.ts";
import { postPolaris as sendPolaris } from "./polarisClient.ts";
import { configPath, readConfig } from "./config.ts";
import { openState } from "./state.ts";
import { accountPlan, createAccountService } from "./accounts.ts";

export async function startBridge() {
  let file = readConfig();
  const origin = (process.env.T3_ORIGIN ?? file.T3_ORIGIN ?? "http://127.0.0.1:3773").replace(
    /\/$/,
    "",
  );
  const token = process.env.T3_TOKEN ?? file.T3_TOKEN;
  if (!token) throw new Error("T3_TOKEN is required");
  const polaris = (
    process.env.POLARIS_SERVER ??
    file.POLARIS_SERVER ??
    "http://127.0.0.1:43117"
  ).replace(/\/$/, "");
  const bridgeToken = process.env.POLARIS_T3_BRIDGE_TOKEN ?? file.POLARIS_T3_BRIDGE_TOKEN;
  const statePath =
    process.env.POLARIS_T3_BRIDGE_STATE ??
    file.POLARIS_T3_BRIDGE_STATE ??
    NodePath.join(NodeOS.homedir(), ".polaris/t3-bridge-state.json");
  const port = Number(process.env.POLARIS_T3_BRIDGE_PORT ?? file.POLARIS_T3_BRIDGE_PORT ?? 43118);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  const { state, save } = openState(statePath);
  const log = (s: string) => console.error(`[polaris-bridge] ${s.slice(0, 300)}`);
  const t3 = (pathname: string, options: RequestInit = {}) =>
    t3Request(origin, headers, pathname, options);
  const postPolaris = (pathname: string, body: object) => sendPolaris(polaris, pathname, body);
  let client: Client | undefined;
  let serverConfig: ServerConfig | undefined;
  let shellProjects: readonly OrchestrationProjectShell[] = [];
  let connected = false;
  const watched = new Map<string, AbortController>();
  const touched = new Map<string, number>();
  function requireClient() {
    if (!client || !serverConfig) throw new Error("T3 is disconnected");
    return client;
  }
  const { accounts, refreshUsage, provision } = createAccountService({
    get serverConfig() {
      return serverConfig;
    },
    set serverConfig(value) {
      serverConfig = value;
    },
    get file() {
      return file;
    },
    state,
    save,
    requireClient,
    t3,
  });
  const projectId = () => ProjectId.make(NodeCrypto.randomUUID());
  const commandId = () => CommandId.make(NodeCrypto.randomUUID());
  const threadId = (id: string) => ThreadId.make(id);
  const messageId = () => MessageId.make(NodeCrypto.randomUUID());
  const currentPublicOrigin = () =>
    publicOrigin(
      process.env.T3_PUBLIC_ORIGIN ?? file.publicOrigin,
      serverConfig?.directEndpoints ?? [],
      origin,
    );
  const link = (id: string) =>
    `${currentPublicOrigin()}/threads/${encodeURIComponent(serverConfig?.environment.environmentId ?? "")}/${encodeURIComponent(id)}`;
  async function projection(id: string) {
    return Effect.runPromise(
      requireClient()["orchestration.getThreadProjection"]({ threadId: threadId(id) }),
    );
  }
  const { flush, refreshLinks } = createEventService({
    get file() {
      return file;
    },
    get serverConfig() {
      return serverConfig;
    },
    state,
    save,
    accounts,
    projection,
    changeAccount: (...args) => changeAccount(...args),
    requireClient,
    commandId,
    messageId,
    threadId,
    link,
    log,
    postPolaris,
  });
  const { create, stop, watch, handleShell } = createThreadService({
    get file() {
      return file;
    },
    get serverConfig() {
      return serverConfig;
    },
    get client() {
      return client;
    },
    get connected() {
      return connected;
    },
    get shellProjects() {
      return shellProjects;
    },
    set shellProjects(value) {
      shellProjects = value;
    },
    state,
    save,
    accounts,
    refreshUsage,
    projection,
    requireClient,
    commandId,
    messageId,
    projectId,
    threadId,
    t3,
    postPolaris,
    link,
    log,
    flush,
    watched,
    touched,
  });
  const { input, changeAccount } = createInputService({
    get file() {
      return file;
    },
    get serverConfig() {
      return serverConfig;
    },
    state,
    save,
    accounts,
    refreshUsage,
    projection,
    requireClient,
    commandId,
    messageId,
    threadId,
    origin,
    link,
    flush,
    watch: (id) => watch(id),
  });
  const route = createRoute(() => ({
    bridgeToken,
    origin,
    polaris,
    log,
    connected,
    serverConfig,
    file,
    state,
    refreshUsage,
    accounts,
    create,
    input,
    changeAccount,
    stop,
    watch,
    projection,
    link,
  }));
  let provisioningRetry: ReturnType<typeof setTimeout> | undefined;
  function reloadProvisioning() {
    if (!connected) return;
    void provision()
      .then(() => refreshLinks())
      .catch(() => {
        log("Account provisioning failed; retrying");
        provisioningRetry = setTimeout(reloadProvisioning, 1000);
      });
  }
  NodeFS.watchFile(configPath, { interval: 2000 }, () => {
    try {
      const next = readConfig();
      accountPlan(next.accounts, process.env.POLARIS_T3_BRIDGE_ALLOW_REPLAY === "1");
      file = next;
      if (provisioningRetry) clearTimeout(provisioningRetry);
      reloadProvisioning();
    } catch {
      log("Could not reload bridge configuration");
    }
  });
  const server = NodeHttp.createServer((req, res) => {
    void route(req, res);
  });
  server.listen(port, "127.0.0.1", () => log(`listening on 127.0.0.1:${port}`));
  const sweep = setInterval(() => {
    for (const [id, controller] of watched)
      if ((touched.get(id) ?? 0) < Date.now() - 120_000) {
        void projection(id)
          .then((p) => {
            if (turnState(p) === "idle" || turnState(p) === "failed") controller.abort();
          })
          .catch(() => {});
      }
  }, 30_000);
  process.on("SIGTERM", () => {
    clearInterval(sweep);
    if (provisioningRetry) clearTimeout(provisioningRetry);
    NodeFS.unwatchFile(configPath);
    for (const c of watched.values()) c.abort();
    server.close();
    process.exit(0);
  });
  await runConnection({
    get client() {
      return client;
    },
    set client(value) {
      client = value;
    },
    get serverConfig() {
      return serverConfig;
    },
    set serverConfig(value) {
      serverConfig = value;
    },
    get connected() {
      return connected;
    },
    set connected(value) {
      connected = value;
    },
    get shellProjects() {
      return shellProjects;
    },
    set shellProjects(value) {
      shellProjects = value;
    },
    origin,
    t3,
    provision,
    refreshLinks,
    currentPublicOrigin,
    handleShell,
    state,
    save,
    watched,
    log,
  });
}
