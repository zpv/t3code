// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- The test exercises the loopback HTTP route.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import { createRoute } from "./http.ts";
import { createInputReceipts } from "./inputReceipts.ts";
import type { State } from "./state.ts";

it("returns a stored input response while T3 is disconnected", async () => {
  const state: State = {
    threads: { thread: { runId: "run", events: [], dispatched: [], outbox: [] } },
  };
  const receipt = createInputReceipts(
    state,
    () => {},
    async () => {
      throw new Error("disconnected");
    },
  );
  const answer = { ok: true, delivery: "replied", messageId: null, reply: "cached" };
  await receipt("thread", "key", async () => answer);
  const route = createRoute(
    () =>
      ({
        bridgeToken: undefined,
        origin: "",
        polaris: "",
        log: () => {},
        connected: false,
        serverConfig: undefined,
        file: {},
        state,
        input: (id: string, body: { inputId?: string }) =>
          receipt(id, body.inputId, async () => {
            throw new Error("disconnected");
          }),
      }) as never,
  );
  const server = NodeHttp.createServer(route);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const url = `http://127.0.0.1:${address.port}/v1/threads/thread/input`;
    const post = (inputId: string) =>
      fetch(url, { method: "POST", body: JSON.stringify({ input: "x", inputId }) });
    const cached = await post("key");
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual(answer);
    expect((await post("new")).status).toBe(503);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
