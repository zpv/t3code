# Spec A round 2: Job 2 report

## Bridge

The bridge serves the loopback API, uses a ticket-authenticated T3 WebSocket, maps runs to threads, and persists its event outbox and cursors. It selects instances and model options from configuration, uploads attachments, renders snapshots, adopts eligible threads, and forwards events, state and phone notifications to polarisd. The smoke scripts use isolated temporary T3 homes and fake polarisd servers. No live `~/.t3` database was used.

## Acceptance results

- `vp run --filter @t3tools/polaris-bridge typecheck`: exit 0.
- `vp run --filter @t3tools/polaris-bridge test`: exit 0, `Test Files 2 passed (2)`, `Tests 5 passed (5)`. The tests cover the input table, snapshot rendering, event identities across a serialized restart, bridge-origin message suppression, questions and approvals, replay of a request after resolution, effort options and instance selection.
- `node apps/polaris-bridge/scripts/smoke.ts`: exit 0 in `/var/folders/yx/3lbxv4sn1wgf4n9gf5mm9_340000gn/T/polaris-smoke-OMfl3I`:

  ```text
  Bearer-only WebSocket upgrade: 101
  PASS replay completion, snapshot, restart deduplication, and direct-thread adoption
  ```

  The runner records its own dev-runner PID at spawn and signals it for cleanup. The passing run also verified an idempotent repeat and recovery from a simulated crash before thread creation. An earlier run timed out during repeated server watch restarts while Job 1 was editing the server.

- `node apps/polaris-bridge/scripts/smoke-import.ts`: run once, exit 1. Claude imported 2 messages, resumed from the linked worktree, returned `marmalade`, and had no `contextHandoffs`. Its resumed turn reported 65,161 input tokens (47,449 cached) and 6 output tokens. The initial Claude CLI invocation reported $0.00737692 and 99 output tokens.

  Codex was logged in; its initial CLI turn reported 28,432 input tokens (12,800 cached) and 51 output tokens. The T3 dev server restarted while the Codex turn was active because `apps/server/src/polaris/ImportSession.ts` changed in the concurrently running Job 1. The first run was cancelled and a restart continuation returned `OK`, so the assertion failed:

  ```text
  codex import or resume: AssertionError [ERR_ASSERTION]: The input did not match the regular expression /marmalade/i. Input:
  'OK'
  ```

  The isolated database records a strong native thread reference, 0 context handoffs, a cancelled first Codex run and a completed continuation with no context handoff ID. The interrupted first run does not prove whether Codex would have answered correctly without the server restart. Evidence: `/var/folders/yx/3lbxv4sn1wgf4n9gf5mm9_340000gn/T/polaris-import-S6H8ik`.

- `vp run check:changed main`: exit 1. Lint, unused patches, server GraphQL, typecheck (42 packages) and affected tests (5 files, 11 tests) passed. Format reported `apps/server/src/polaris/ImportSession.test.ts`, which belongs to Job 1 and was being edited concurrently. Knip reported:
  - `apps/polaris-bridge/scripts/check-seams.ts`, `smoke.ts`, `smoke-import.ts` and `smoke-rpc.ts` as unused files. These are executable fork entry points and their helper; adding them to the upstream root Knip configuration is outside the permitted fork seams.
  - `@effect/platform-node`, `@effect/platform-node-shared` and `@t3tools/shared` as unused dependencies in the bridge. The spec explicitly requires these dependencies; changing the upstream Knip configuration to ignore them is outside the permitted seams.
  - `proxyTarget` in `apps/server/src/polaris/Proxy.ts` as an unused export. That file belongs to Job 1.

## Open questions and contract notes

- Claude resumed the native session from a linked worktree cwd and retained the code word. The resumed projection contained no portable handoff.
- A bearer token directly on the `/ws?orchestrationProtocol=2` upgrade returned HTTP 101. The bridge uses the specified short-lived ticket flow.
- The contract describes a single pending question, while T3 runtime requests can contain multiple questions. The bridge currently answers the first question; the contract needs a representation for multi-question responses.
- During the Codex server restart, T3 generated a user-role continuation authored by the agent. It must not be forwarded as a UI `user.prompt`; the bridge filters on the message's author as well as the recorded dispatched IDs.
