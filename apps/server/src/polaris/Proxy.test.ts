// @effect-diagnostics nodeBuiltinImport:off -- The fixture serves real HTTP and streaming responses.
import { describe, expect, it } from "vite-plus/test";
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerHttp from "../http.ts";
import * as ServerConfig from "../config.ts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as Proxy from "./Proxy.ts";

async function fixture(scopes: ReadonlyArray<AuthEnvironmentScope>, missing = false) {
  const requests: Array<{
    url: string | undefined;
    method: string | undefined;
    headers: NodeHttp.IncomingHttpHeaders;
    body: string;
  }> = [];
  const stream = Promise.withResolvers<NodeHttp.ServerResponse>();
  let authenticationCalls = 0;
  const server = NodeHttp.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (part: string) => {
      body += part;
    });
    req.on("end", () => {
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (req.url?.startsWith("/v0/events/stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        stream.resolve(res);
      } else {
        res.writeHead(200, { "set-cookie": "secret=upstream" });
        res.end("ok");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.merge(Proxy.layer, ServerHttp.layerBrowserApiCors).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "polaris-proxy-cors-" })),
      Layer.provide(NodeServices.layer),
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateWebSocketUpgrade: () => {
            authenticationCalls++;
            return missing
              ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("test"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes,
                });
          },
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ POLARIS_SERVER: origin })),
      ),
    ),
    { disableLogger: true },
  );
  return {
    handler,
    requests,
    authenticationCalls: () => authenticationCalls,
    stream,
    close: async () => {
      await dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    stopServer: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const url = "http://t3.test/api/polaris/proxy";
describe("Polaris proxy", () => {
  it("enforces authentication and scopes, restricts paths, and strips credentials", async () => {
    const reader = await fixture([AuthOrchestrationReadScope]);
    const operator = await fixture([AuthOrchestrationOperateScope, AuthTerminalOperateScope]);
    const limited = await fixture([AuthOrchestrationOperateScope]);
    const unauthenticated = await fixture([], true);
    try {
      expect((await unauthenticated.handler(new Request(`${url}/v0/runs`))).status).toBe(401);
      expect((await reader.handler(new Request(`${url}/v0/runs`, { method: "POST" }))).status).toBe(
        403,
      );
      expect((await operator.handler(new Request(`${url}/v0/runs`))).status).toBe(403);
      expect(
        (await limited.handler(new Request(`${url}/v0/runs`, { method: "POST" }))).status,
      ).toBe(403);
      const preflight = await unauthenticated.handler(
        new Request(`${url}/v0/runs`, {
          method: "OPTIONS",
          headers: {
            origin: "https://client.example",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        }),
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      expect(unauthenticated.authenticationCalls()).toBe(1);
      expect((await reader.handler(new Request(`${url}/v1/runs`))).status).toBe(404);
      const response = await reader.handler(
        new Request(`${url}/v0/runs?wsTicket=secret&since=1`, {
          headers: {
            authorization: "Bearer secret",
            cookie: "session=secret",
            dpop: "secret",
            "x-test": "retained",
          },
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toBe("ok");
      expect(reader.requests).toHaveLength(1);
      expect(reader.requests[0]?.url).toBe("/v0/runs?since=1");
      expect(reader.requests[0]?.headers).not.toHaveProperty("authorization");
      expect(reader.requests[0]?.headers).not.toHaveProperty("cookie");
      expect(reader.requests[0]?.headers).not.toHaveProperty("dpop");
      expect(reader.requests[0]?.headers["x-test"]).toBe("retained");
      const changed = await operator.handler(
        new Request(`${url}/v0/runs?wsTicket=secret`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://client.example" },
          body: '{"a":1}',
        }),
      );
      expect(changed.status).toBe(200);
      expect(changed.headers.get("access-control-allow-origin")).toBe("*");
      expect(operator.authenticationCalls()).toBe(2);
      await changed.text();
      expect(operator.requests[0]?.url).toBe("/v0/runs");
      expect(operator.requests[0]?.body).toBe('{"a":1}');
    } finally {
      await Promise.all([
        reader.close(),
        operator.close(),
        limited.close(),
        unauthenticated.close(),
      ]);
    }
  });

  it("delivers SSE chunks before the upstream closes", async () => {
    const f = await fixture([AuthOrchestrationReadScope]);
    try {
      const response = await f.handler(new Request(`${url}/v0/events/stream`));
      expect(response.status).toBe(200);
      const body = response.body!.getReader();
      expect(new TextDecoder().decode((await body.read()).value)).toBe("data: first\n\n");
      const upstream = await f.stream.promise;
      upstream.write("data: second\n\n");
      expect(new TextDecoder().decode((await body.read()).value)).toBe("data: second\n\n");
      upstream.end();
      expect((await body.read()).done).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("returns 502 when polarisd is down", async () => {
    const f = await fixture([AuthOrchestrationReadScope]);
    await f.stopServer();
    try {
      const response = await f.handler(new Request(`${url}/v0/runs`));
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "Polaris server unavailable" });
    } finally {
      await f.close();
    }
  });
});
