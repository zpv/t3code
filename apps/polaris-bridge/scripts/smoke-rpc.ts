// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Live smoke RPC owns its connection.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

export async function createDirect(origin: string, token: string, projectId: string) {
  const response = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`ticket: ${response.status}`);
  const { ticket } = (await response.json()) as { ticket: string };
  const socket = Socket.layerWebSocket(
    `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(socket),
    Layer.provide(RpcSerialization.layerJson),
  );
  const id = ThreadId.make(NodeCrypto.randomUUID());
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        yield* client["orchestration.launchThread"]({
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId: id,
          projectId: ProjectId.make(projectId),
          title: "Direct adoption",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-haiku-5-5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        });
      }),
    ).pipe(Effect.provide(protocol)),
  );
  return id;
}

export async function readProjection(origin: string, token: string, threadId: string) {
  const response = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`ticket: ${response.status}`);
  const { ticket } = (await response.json()) as { ticket: string };
  const socket = Socket.layerWebSocket(
    `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(socket),
    Layer.provide(RpcSerialization.layerJson),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        return yield* client["orchestration.getThreadProjection"]({
          threadId: ThreadId.make(threadId),
        });
      }),
    ).pipe(Effect.provide(protocol)),
  );
}

export async function dispatchDirect(
  origin: string,
  token: string,
  threadId: string,
  text: string,
) {
  const response = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`ticket: ${response.status}`);
  const { ticket } = (await response.json()) as { ticket: string };
  const socket = Socket.layerWebSocket(
    `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(socket),
    Layer.provide(RpcSerialization.layerJson),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        yield* client["orchestration.dispatchCommand"]({
          type: "message.dispatch",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId: ThreadId.make(threadId),
          messageId: MessageId.make(NodeCrypto.randomUUID()),
          text,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
      }),
    ).pipe(Effect.provide(protocol)),
  );
}
