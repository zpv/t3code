# Polaris fork seams

| File                        | Marker                                | Reason                             |
| --------------------------- | ------------------------------------- | ---------------------------------- |
| `apps/server/src/server.ts` | `polaris-fork: proxy import`          | Import the polarisd proxy route.   |
| `apps/server/src/server.ts` | `polaris-fork: proxy route`           | Register the polarisd proxy route. |
| `apps/server/src/server.ts` | `polaris-fork: import session import` | Import the native session route.   |
| `apps/server/src/server.ts` | `polaris-fork: import session route`  | Register the native session route. |
