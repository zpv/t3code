# Spec E, Job 1

The bridge records a stable start event for each started run, attributing it to the input endpoint or T3 by the triggering message ID. The existing durable outbox keeps unacknowledged events for replay. Input receipts are stored per thread for eight days, including the command ID, original response, and any account-switch event; concurrent retries are serialized and accepted commands are replayed through T3's command receipt. Expired receipts are pruned when input arrives.

The merge tool is `apps/polaris-bridge/scripts/merge-upstream.ts`. It requires a clean `polaris` checkout, fetches upstream, handles generated-file conflicts, runs the specified checks, and rolls back a merge when verification fails. Its web route regeneration runs `vp run --filter @t3tools/web build`, which invokes the TanStack router Vite plugin.

Validation:

- Bridge typecheck passed.
- Bridge tests passed, including start origin, queued runs, outbox restart, input replay after a lost T3 response, concurrent retries, retention and conflict classification.
- Bridge smoke passed using isolated home and ports, including one start event per run with both origins, a repeated input ID and replay after bridge restart.
- Merge dry run passed in a separate clean clone against the configured upstream: `would merge 35 upstream commits`. The shared checkout correctly refuses the command while dirty.
- `vp run check:changed HEAD` was run in the shared checkout; its result is being rechecked as the other jobs finish.
