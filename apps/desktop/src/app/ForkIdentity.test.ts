import { expect, it } from "vite-plus/test";
import { FORK_IDENTITY, forkLinkPath } from "@t3tools/shared/remote";

it("maps only supported fork links to local routes", () => {
  expect(forkLinkPath("polaris-t3://thread/env-1/thread-1")).toBe("/env-1/thread-1");
  expect(forkLinkPath("polaris-t3-dev://polaris")).toBe("/polaris");
  expect(forkLinkPath("t3code://thread/env-1/thread-1")).toBeNull();
  expect(forkLinkPath("polaris-t3://thread/env-1/thread-1?x=1")).toBeNull();
  expect(forkLinkPath("polaris-t3://app/settings/providers?instanceId=work&code=secret")).toBe(
    "/settings/providers?instanceId=work",
  );
  expect(FORK_IDENTITY.home).toBe(".polaris-t3");
});
