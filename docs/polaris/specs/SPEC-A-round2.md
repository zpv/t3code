# Spec A, round 2

Round 1 delivered about 200 lines (proxy route, seam checker, input parser stub,
runbook draft) and stopped with most of `SPEC-A-bridge-and-server.md` unbuilt. That
spec is still the requirement. This file splits the remaining work into two jobs that
run at the same time in this checkout, and records corrections.

Rules for both jobs:

- The job is finished only when every acceptance item listed for it below has been run
  and passes, or a specific external blocker is shown with the exact failing output. Do
  not stop to report partial progress. If something is hard, keep going: read the
  upstream code the spec points to and copy its patterns.
- Do not commit or push. Do not touch files owned by the other job.
- Node: put `$HOME/.local/share/vite-plus/js_runtime/node/26.12.1/bin:$HOME/.local/share/vite-plus/bin`
  first on `PATH`. Never touch `~/.t3`. `T3CODE_TELEMETRY_ENABLED=false`.

Corrections to round 1:

- `apps/server/src/server.ts`: replace the dynamic `import()` inside `layerMakeRoutes`
  with a normal static import at the top of the file and plain entries in
  `layerMakeRoutes`, matching how `DeviceHubProxy` is wired. Each added line carries a
  `// polaris-fork: <name>` comment and has a row in `docs/polaris/SEAMS.md`. (Job 1 owns
  `server.ts` and `SEAMS.md`.)
- `CONTRACT.md` now requires a stable `eventId` on every event the bridge posts
  (see "polarisd API used by the bridge"). The bridge retries until acknowledged.

## Job 1: server routes (`apps/server/src/polaris/**`, `server.ts`, `SEAMS.md`)

Owns: `apps/server/src/polaris/**`, the seam lines in `apps/server/src/server.ts`,
`docs/polaris/SEAMS.md`, `apps/polaris-bridge/scripts/check-seams.ts`.

Build §2 of the spec completely:

1. `POST /api/polaris/import-session`, as specified, including the orchestrator-driven
   test that proves the first message to an imported thread resumes the native session
   without a duplicate portable handoff. Start from
   `apps/server/src/project/AgentSessionImporter.ts` (how it builds `thread.created`,
   `messageEvents`, `provider-thread.updated`, and calls `EventSinkV2.write` with
   `unlessNativeThreadOwned`) and its test file. Read
   `shouldPrepareLegacyImportHandoff` and its callers in
   `apps/server/src/orchestration-v2/Orchestrator.ts` to decide what `historyOrigin`
   to write. Also read how `ProviderTurnStartService.ts` resumes a provider thread that
   has a `nativeThreadRef`.
2. Finish the proxy: tests that exercise auth rejection, method/scope mapping, header
   stripping, the `/v0/` allowlist, a streamed SSE response delivered incrementally,
   and `502` when polarisd is down, using a local HTTP server as the fake polarisd.

Acceptance for Job 1:

- `vp run --filter t3 typecheck`
- `vp test run apps/server/src/polaris` (the tests above, not placeholders)
- `node apps/polaris-bridge/scripts/check-seams.ts` exits 0, and non-zero with a marker removed
- `git diff --stat main -- apps packages ':!apps/polaris-bridge'` lists only `apps/server/src/server.ts` among tracked upstream files
- Write `docs/polaris/specs/SPEC-A-report-job1.md`: results of each item, the exact
  request/response shape of the import route as built, and the answer on duplicate
  handoff with the evidence.

## Job 2: bridge (`apps/polaris-bridge/**`, `apps/polaris-bridge/scripts/smoke*.ts`, `RUNBOOK.md`)

Owns: `apps/polaris-bridge/**`, `apps/polaris-bridge/scripts/smoke.ts`,
`apps/polaris-bridge/scripts/smoke-import.ts`, `docs/polaris/RUNBOOK.md`.

Build §1 of the spec completely, plus the two smoke scripts in the spec's acceptance
items 5 and 6. The import route is being built by Job 1 at
`POST /api/polaris/import-session` with the body in the spec §2; code against that
shape, and before running `smoke-import.ts` read
`docs/polaris/specs/SPEC-A-report-job1.md` (wait for it to exist) and adjust.

Start from `apps/server/scripts/verify-background-live.ts` for the WS RPC client and
`scripts/mobile-behavior/environment.ts` for a second example. Read the schemas you
dispatch in `packages/contracts/src/orchestrationV2.ts` and `rpc.ts`.

Acceptance for Job 2:

- `vp run --filter @t3tools/polaris-bridge typecheck` and
  `vp run --filter @t3tools/polaris-bridge test`, with unit tests for: every row of the
  contract's input table, snapshot rendering, event derivation (exactly-once across a
  simulated restart, bridge-dispatched messages not reported as `user.prompt`, question
  vs approval), effort/option mapping, instance selection.
- `node apps/polaris-bridge/scripts/smoke.ts` passes (spec acceptance item 5), run for real.
- `node apps/polaris-bridge/scripts/smoke-import.ts` run once for real (spec acceptance item 6),
  with its findings recorded.
- `vp run check:changed main` passes, or each remaining failure is listed with why it
  is out of scope (run it after Job 1's report exists).
- Write `docs/polaris/specs/SPEC-A-report-job2.md`: results of each item, answers to
  the open questions (Claude resume from a worktree cwd; bearer header directly on the
  `/ws` upgrade), and any contract problems found.
