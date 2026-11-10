// @effect-diagnostics globalFetch:off globalTimers:off globalRandom:off extendsNativeError:off -- The bridge owns its HTTP client.
export class HttpFailure extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export async function t3Request(
  origin: string,
  headers: Record<string, string>,
  pathname: string,
  options: RequestInit = {},
) {
  const res = await fetch(origin + pathname, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!res.ok)
    throw new HttpFailure(res.status, `T3 ${pathname}: ${res.status} ${await res.text()}`);
  return res.json();
}

export class Refusal extends Error {}

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  WsRpcGroup,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ServerConfig,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import type { State } from "./state.ts";
export const makeClient = () => RpcClient.make(WsRpcGroup);
export type Client = Effect.Success<ReturnType<typeof makeClient>>;
type ConnectionContext = {
  client: Client | undefined;
  serverConfig: ServerConfig | undefined;
  connected: boolean;
  shellProjects: readonly OrchestrationProjectShell[];
  origin: string;
  t3: (pathname: string, options?: RequestInit) => Promise<unknown>;
  provision: () => Promise<void>;
  refreshLinks: () => Promise<void>;
  currentPublicOrigin: () => string;
  handleShell: (thread: OrchestrationV2ThreadShell) => Promise<void>;
  state: State;
  save: () => void;
  watched: Map<string, AbortController>;
  log: (text: string) => void;
};
export async function runConnection(ctx: ConnectionContext) {
  const {
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
  } = ctx;
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  async function connect() {
    const ticket = (await t3("/api/auth/websocket-ticket", { method: "POST" })) as {
      ticket: string;
    };
    const socket = Socket.layerWebSocket(
      `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
    ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
    const protocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(socket),
      Layer.provide(RpcSerialization.layerJson),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const c = yield* makeClient();
          ctx.client = c;
          ctx.serverConfig = yield* c["server.getConfig"]({});
          yield* Effect.promise(provision);
          ctx.connected = true;
          log(`connected to ${origin}`);
          yield* c["subscribeServerConfig"]({}).pipe(
            Stream.runForEach((item) =>
              Effect.promise(async () => {
                if (!ctx.serverConfig) return;
                const previousOrigin = currentPublicOrigin();
                if (item.type === "snapshot") ctx.serverConfig = item.config;
                else if (item.type === "providerStatuses")
                  ctx.serverConfig = { ...ctx.serverConfig, providers: item.payload.providers };
                else if (item.type === "settingsUpdated")
                  ctx.serverConfig = { ...ctx.serverConfig, settings: item.payload.settings };
                const nextOrigin = currentPublicOrigin();
                if (previousOrigin !== nextOrigin) await refreshLinks();
              }),
            ),
            Effect.forkScoped,
          );
          const cursor = state.shellCursor;
          if (cursor !== undefined) {
            const snapshot = yield* Effect.promise(
              () => t3("/api/orchestration/shell") as Promise<OrchestrationV2ShellSnapshot>,
            );
            ctx.shellProjects = snapshot.projects;
            yield* Effect.promise(() =>
              Promise.all([...snapshot.threads, ...snapshot.archivedThreads].map(handleShell)),
            );
          }
          yield* c["orchestration.subscribeShell"](
            cursor === undefined ? {} : { afterSequence: cursor },
          ).pipe(
            Stream.runForEach((item) =>
              Effect.promise(async () => {
                if (item.kind === "snapshot") {
                  ctx.shellProjects = item.snapshot.projects;
                  await Promise.all(
                    [...item.snapshot.threads, ...item.snapshot.archivedThreads].map(handleShell),
                  );
                  state.shellCursor = item.snapshot.snapshotSequence;
                  save();
                } else if (item.kind === "project.updated") {
                  ctx.shellProjects = [
                    ...ctx.shellProjects.filter((p) => p.id !== item.project.id),
                    item.project,
                  ];
                  state.shellCursor = item.sequence;
                  save();
                } else if (item.kind === "project.removed") {
                  ctx.shellProjects = ctx.shellProjects.filter((p) => p.id !== item.projectId);
                  state.shellCursor = item.sequence;
                  save();
                } else if (item.kind === "thread.updated") {
                  await handleShell(item.thread);
                  state.shellCursor = item.sequence;
                  save();
                } else if (item.kind === "thread.removed") {
                  state.shellCursor = item.sequence;
                  save();
                }
              }),
            ),
          );
        }),
      ).pipe(Effect.provide(protocol)),
    );
  }
  let backoff = 250;
  for (;;) {
    try {
      await connect();
      backoff = 250;
    } catch (error) {
      log(`connection: ${String(error)}`);
    }
    ctx.connected = false;
    ctx.client = undefined;
    for (const c of watched.values()) c.abort();
    watched.clear();
    await delay(backoff + (Math.random() * backoff) / 4);
    backoff = Math.min(backoff * 2, 30_000);
  }
}
