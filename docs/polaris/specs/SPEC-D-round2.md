# Spec D, round 2

Round 1 (`SPEC-D-report.md`) delivered the behaviour and passed its acceptance checks,
and a real end-to-end run with `polarisd` passed. It left two things it named itself,
plus two paths that have never been exercised live. `SPEC-D-sync-accounts-remote.md`
still applies, including its constraints (no upstream edits; do not stop or restart the
running desktop app and demo stack; isolated servers on free ports only). Do not commit
or push. You are done only when every acceptance item below has been run and passes.

1. **Finish the module split.** `apps/polaris-bridge/src/bin.ts` must contain wiring
   only (config load, constructing the clients, starting the HTTP server, shutdown).
   Orchestration, provisioning, dispatch, HTTP routing and the WebSocket lifecycle move
   into the modules named in the spec. No behaviour change.
2. **Auto-switch and provisioning under failure.** Make the switch a durable, resumable
   step: persist intent before acting (`switching: {from, to, failedRunId}`), and on
   restart finish or abandon it so that exactly one `Continue where you left off.` is
   dispatched and exactly one `t3.account.switched` is posted. Tests, driving the pure
   core with a fake T3 client and fake polarisd: crash after intent is saved; crash
   after the thread moved but before the continue message; crash after the continue
   message but before the event was acknowledged; polarisd down during the switch; all
   accounts limited; provisioning when `server.updateSettings` fails once then succeeds;
   config reload that removes an account a thread is on (thread stays on its instance,
   the account is listed as `enabled: false`, nothing is deleted while a thread uses it).
3. **A message typed in the T3 client.** Extend `scripts/smoke.ts`: into a thread the
   bridge created, dispatch a user message over a second, direct RPC session exactly as
   the web client does (`createdBy: "user"`, `creationSource: "web"`), and assert the
   fake polarisd receives exactly one `user.prompt` with `origin: "t3"` and that text,
   plus the run's `assistant.completed`; and that a message sent through the bridge
   `input` endpoint produces no `user.prompt`.
4. **Questions and approvals, live on the replay provider.** Find a `Replay (dev)`
   scenario that raises an approval request and one that raises a user-input question
   (`showcase` covers an approval; look in `apps/server/scripts/dev-replay-agent.ts` and
   the replay fixtures for a question, and add a small fork-owned scenario file only if
   the dev agent supports loading one without upstream edits). In the smoke: run it
   through the bridge, assert the fake polarisd receives `claude.notification` (approval)
   or `claude.ask_user_question` (question) with the expected text and options, that
   `GET /v1/threads/{id}` reports `pendingRequest` and `turnState: "waiting"`, answer
   through `input` (`yes` / an option number), and assert the run continues to an
   `assistant.completed`. If no question scenario can be produced without an upstream
   edit, say so in the report and cover it in the unit tests with a recorded
   `user_input_request` item instead.

## Acceptance

- `vp run --filter @t3tools/polaris-bridge typecheck` and `… test`
- `node apps/polaris-bridge/scripts/smoke.ts` passes with items 3 and 4
- `node apps/polaris-bridge/scripts/check-seams.ts`; `git diff --stat HEAD -- apps packages`
  touches only fork-owned paths
- `wc -l apps/polaris-bridge/src/bin.ts` is under 150
- `vp run check:changed HEAD`
- Update `docs/polaris/specs/SPEC-D-report.md`; remove statements that no longer hold.
