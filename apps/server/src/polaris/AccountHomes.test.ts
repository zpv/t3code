import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  makeClaudeContinuationGroupKey,
  mergeClaudeProcessEnvironment,
} from "../provider/Drivers/ClaudeHome.ts";

it.layer(NodeServices.layer)("Polaris Claude accounts", (it) => {
  it.effect("shares continuation identity while passing the account token to Claude", () =>
    Effect.gen(function* () {
      const homePath = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "polaris-claude-",
      });
      const config = { homePath };
      const first = yield* makeClaudeContinuationGroupKey(config);
      const second = yield* makeClaudeContinuationGroupKey(config);
      expect(first).toBe(second);
      const environment = yield* mergeClaudeProcessEnvironment(
        config,
        [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "test-token", sensitive: true }],
        { CLAUDE_CODE_SESSION_ID: "host-session" },
      );
      expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-token");
      expect(environment.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    }),
  );
});
