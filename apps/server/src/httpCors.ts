// polaris-fork: identity import
import { FORK_IDENTITY } from "@t3tools/shared/remote";
import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

export const DESKTOP_RENDERER_ORIGINS = [
  "t3code://app",
  "t3code-dev://app",
  `${FORK_IDENTITY.scheme}://app`,
  `${FORK_IDENTITY.devScheme}://app`,
] as const; // polaris-fork: cors origins
