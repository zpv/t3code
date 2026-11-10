// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off -- The bridge owns its loopback HTTP API.
import type * as NodeHttp from "node:http";
import type { ServerConfig, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { Account } from "./accounts.ts";
import type { ConfigFile } from "./config.ts";
import type { State } from "./state.ts";
import { HttpFailure, Refusal } from "./t3Client.ts";
import { pendingRequest } from "./logic.ts";
import { turnState, effort, nativeSession } from "./threads.ts";
import { renderSnapshot } from "./snapshot.ts";
import type { Create } from "./threads.ts";

type Dependencies = {
  bridgeToken: string | undefined;
  origin: string;
  polaris: string;
  log: (text: string) => void;
  connected: boolean;
  serverConfig: ServerConfig | undefined;
  file: ConfigFile;
  state: State;
  refreshUsage: () => Promise<void>;
  accounts: () => Account[];
  create: (input: Create, importing: boolean) => Promise<{ code: number; body: object }>;
  input: (
    id: string,
    body: { input: string; inputId?: string; attachments?: { path: string; name?: string }[] },
  ) => Promise<object>;
  changeAccount: (id: string, profile: string) => Promise<object>;
  stop: (id: string) => Promise<object>;
  watch: (id: string) => void;
  projection: (id: string) => Promise<OrchestrationV2ThreadProjection>;
  link: (id: string) => string;
};
export function createRoute(deps: () => Dependencies) {
  return async function route(req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) {
    const {
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
    } = deps();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    log(`${req.method} ${url.pathname}`);
    const reply = (status: number, body: object) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (bridgeToken && req.headers.authorization !== `Bearer ${bridgeToken}`)
      return reply(401, { error: "Unauthorized" });
    try {
      if (req.method === "GET" && url.pathname === "/v1/health")
        return reply(200, {
          ok: true,
          t3: { connected, origin, environmentId: serverConfig?.environment.environmentId ?? null },
          polaris: { server: polaris },
        });
      if (
        !connected &&
        !(req.method === "POST" && /^\/v1\/threads\/[^/]+\/input$/.test(url.pathname))
      )
        return reply(503, { error: "T3 is disconnected" });
      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const b = Buffer.from(chunk);
          size += b.length;
          if (size > 1024 * 1024) throw new Refusal("Request is too large");
          chunks.push(b);
        }
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      }
      if (req.method === "GET" && url.pathname === "/v1/accounts") {
        await refreshUsage();
        return reply(200, { autoSwitch: file.accounts?.autoSwitch === true, accounts: accounts() });
      }
      if (req.method === "POST" && ["/v1/threads", "/v1/threads/import"].includes(url.pathname)) {
        // polarisd sends absent optional fields as empty strings or null.
        const input = Object.fromEntries(
          Object.entries(body as Record<string, unknown>).filter(
            ([, value]) => value !== "" && value !== null,
          ),
        ) as unknown as Create;
        const result = await create(input, url.pathname.endsWith("/import"));
        return reply(result.code, result.body);
      }
      const match = /^\/v1\/threads\/([^/]+)(?:\/(input|stop|snapshot|account))?$/.exec(
        url.pathname,
      );
      if (!match) return reply(404, { error: "Not found" });
      const id = decodeURIComponent(match[1]!);
      if (!state.threads[id]) return reply(404, { error: "Thread not found" });
      if (req.method === "POST" && match[2] === "input")
        return reply(200, {
          reply: null,
          ...(await input(
            id,
            body as {
              input: string;
              inputId?: string;
              attachments?: { path: string; name?: string }[];
            },
          )),
        });
      if (req.method === "POST" && match[2] === "account") {
        if (typeof body.profile !== "string") throw new Refusal("profile is required");
        return reply(200, await changeAccount(id, body.profile));
      }
      if (req.method === "POST" && match[2] === "stop") return reply(200, await stop(id));
      if (req.method === "GET" && match[2] === "snapshot") {
        watch(id);
        const n = Number(url.searchParams.get("lines") ?? 200);
        return reply(200, {
          output: renderSnapshot(await projection(id), Number.isSafeInteger(n) && n > 0 ? n : 200),
        });
      }
      if (req.method === "GET" && !match[2]) {
        const p = await projection(id),
          provider = serverConfig?.providers.find(
            (v) => v.instanceId === p.thread.providerInstanceId,
          ),
          pending = pendingRequest(p, state.threads[id]?.answers);
        watch(id);
        return reply(200, {
          threadId: id,
          environmentId: serverConfig?.environment.environmentId,
          link: link(id),
          title: p.thread.title,
          agent: provider?.driver === "claudeAgent" ? "claude" : provider?.driver,
          turnState: turnState(p),
          model: p.thread.modelSelection.model,
          effort: effort(p),
          account: (() => {
            const account = accounts().find((a) => a.id === p.thread.providerInstanceId);
            return account
              ? { id: account.id, profile: account.profile, label: account.label }
              : null;
          })(),
          worktreePath: p.thread.worktreePath,
          branch: p.thread.branch,
          nativeSessionId: nativeSession(p),
          pendingRequest: pending
            ? { id: pending.id, kind: pending.kind, text: pending.text, options: pending.options }
            : null,
        });
      }
      return reply(404, { error: "Not found" });
    } catch (error) {
      if (error instanceof Refusal || (error instanceof HttpFailure && error.status === 409))
        return reply(409, { ok: false, reason: error.message });
      if (!connected) return reply(503, { error: "T3 is disconnected" });
      log(`request failed: ${String(error)}`);
      return reply(500, { error: String(error) });
    }
  };
}
