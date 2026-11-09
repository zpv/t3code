import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { authenticateMediaRequest } from "../auth/http.ts";
import { requestUrl } from "../requestUrl.ts";

const prefix = "/api/polaris/proxy";
const droppedHeaders = new Set([
  "host",
  "connection",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
]);

function proxyTarget(url: URL, origin: string): string | null {
  const path = url.pathname.slice(prefix.length);
  if (!path.startsWith("/v0/")) return null;
  const target = new URL(path, origin);
  target.search = url.search;
  target.searchParams.delete("wsTicket");
  return target.toString();
}

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  yield* authenticateMediaRequest(
    request.method === "GET" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope,
  );
  const url = requestUrl(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const origin = yield* Config.String("POLARIS_SERVER").pipe(
    Config.withDefault("http://127.0.0.1:43117"),
  );
  const target = proxyTarget(url.value, origin);
  if (target === null) return HttpServerResponse.text("Not Found", { status: 404 });
  if (!HttpMethod.isHttpMethod(request.method))
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!droppedHeaders.has(name) && value !== undefined) headers[name] = value;
  }
  const upstream = HttpClientRequest.make(request.method)(target).pipe(
    HttpClientRequest.setHeaders(headers),
    request.method === "GET" || request.method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        }),
  );
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const response = yield* client.execute(upstream).pipe(Effect.option);
  if (Option.isNone(response))
    return yield* HttpServerResponse.json({ error: "Polaris server unavailable" }, { status: 502 });
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.value.headers)) {
    if (
      !["connection", "transfer-encoding", "content-encoding", "set-cookie"].includes(name) &&
      value !== undefined
    )
      responseHeaders[name] = value;
  }
  responseHeaders["cache-control"] = "no-store, no-transform";
  return HttpServerResponse.stream(response.value.stream, {
    status: response.value.status,
    headers: responseHeaders,
  });
});

export const layer = HttpRouter.add("*", `${prefix}/*`, handler);
