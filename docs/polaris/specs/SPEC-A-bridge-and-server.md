# Spec A: bridge, session import, polarisd proxy, fork tooling

Read first: `AGENTS.md`, `docs/polaris/README.md`, `docs/polaris/CONTRACT.md`.
Work on branch `polaris` in this checkout. Do not commit, push, or open PRs; leave the
work in the tree for review.

## Objective

Build the T3 Code side of the Polaris integration:

1. `apps/polaris-bridge`: a headless process that connects to the T3 server over WS RPC
   and implements the bridge API and the bridge→polarisd calls in `CONTRACT.md`.
2. `apps/server/src/polaris/`: two authenticated HTTP routes on the T3 server, a session
   import with visible history and a reverse proxy to `polarisd`.
3. Fork tooling: `docs/polaris/SEAMS.md`, `scripts/polaris/check-seams.ts`,
   `docs/polaris/RUNBOOK.md`.

## Hard constraints

- Fork rules in `docs/polaris/README.md` § "Staying mergeable" are binding. The only
  upstream file you may edit is `apps/server/src/server.ts`, and only to add the new
  route layers to `layerMakeRoutes` (one entry each, with a `// polaris-fork` comment).
  If you believe another upstream edit is unavoidable, stop and write the reason in
  `docs/polaris/specs/SPEC-A-notes.md` instead of making it.
- Never read-write, start a server against, or clean `~/.t3`. Use `--home-dir` inside
  this checkout's gitignored `.t3/` or a temp directory. Set `T3CODE_TELEMETRY_ENABLED=false`.
- Node comes from Vite+: put
  `$HOME/.local/share/vite-plus/js_runtime/node/26.12.1/bin:$HOME/.local/share/vite-plus/bin`
  first on `PATH`. The system `node` is v22 and cannot run this repo.
- Kill only processes whose PID you captured at spawn (AGENTS.md "three ways to hurt yourself").
- Follow repo conventions: Effect, `effect-tsgo` typecheck, `vp test`, no repo-wide checks.

## 1. `apps/polaris-bridge`

Package `@t3tools/polaris-bridge`, private, `type: module`, scripts `typecheck`
(`effect-tsgo tsrs --noEmit`), `test`, `start` (`node src/bin.ts`). Depends on
`@t3tools/contracts`, `@t3tools/shared`, `effect`, and the same platform/RPC packages
`apps/server/scripts/verify-background-live.ts` uses. That script is the reference for
connecting: bearer → `POST /api/auth/websocket-ticket` → `/ws?orchestrationProtocol=2&wsTicket=…`
→ `RpcClient.make(WsRpcGroup)`.

### Configuration

Environment, with an optional JSON file at `POLARIS_T3_BRIDGE_CONFIG`
(default `~/.polaris/t3-bridge.json`) supplying the same keys; env wins.

| Key                       | Default                           | Meaning                                          |
| ------------------------- | --------------------------------- | ------------------------------------------------ |
| `T3_ORIGIN`               | `http://127.0.0.1:3773`           | T3 server origin                                 |
| `T3_TOKEN`                | required                          | Bearer from `t3 auth session issue --token-only` |
| `POLARIS_SERVER`          | `http://127.0.0.1:43117`          | polarisd                                         |
| `POLARIS_T3_BRIDGE_PORT`  | `43118`                           | Bridge listen port (bind `127.0.0.1` only)       |
| `POLARIS_T3_BRIDGE_TOKEN` | unset                             | Optional bearer required on the bridge API       |
| `POLARIS_T3_BRIDGE_STATE` | `~/.polaris/t3-bridge-state.json` | Durable bridge state                             |

Config file only: `instances` and `defaults`:

```json
{
  "instances": {
    "claude": { "default": "claudeAgent", "profiles": { "main": "claudeAgent", "2": "claude-2" } },
    "codex": { "default": "codex", "profiles": {} }
  },
  "defaults": {
    "claude": { "model": null, "effort": null },
    "codex": { "model": null, "effort": null },
    "runtimeMode": "full-access",
    "phoneNotifications": true
  }
}
```

`accountProfile` selects a provider instance through `profiles`; an unknown profile
falls back to the agent's default instance and the bridge logs it. When `model` is
absent from a request and from `defaults`, use the server's default model for that
instance. `effort` maps to the model's effort-like option: read the instance's model
options from server config, pick the option whose id is `effort` (Claude) or matches
`/effort|reasoning/i` (Codex), and set it only if the requested value is one of the
option's allowed values; otherwise leave it unset.

### Behaviour

- **Connection.** One WS session with reconnect (jittered backoff, capped at 30 s). One
  `orchestration.subscribeShell` for all threads; one `orchestration.subscribeThread`
  per mapped thread that has an active run, a pending request, or a snapshot requested in
  the last 2 minutes. Release idle thread subscriptions.
- **State.** Persist to `POLARIS_T3_BRIDGE_STATE` (atomic write: temp file + rename):
  the `threadId ↔ runId` map, per-thread high-water marks used to emit each polarisd event
  exactly once (last emitted terminal run id, emitted request ids, emitted user message
  ids, shell/thread sequence cursors), and the set of message ids the bridge itself
  dispatched. On restart, resume from the cursors; never re-emit.
- **Create / import / input / stop / get / snapshot:** exactly as `CONTRACT.md` says.
  - Project lookup: find the T3 project whose workspace root is `repoPath` (compare
    real paths), else create it (title = `projectTitle` or the directory name). Use the
    HTTP project endpoint or RPC the web client uses; do not create the directory.
  - Create uses `orchestration.launchThread` with
    `workspaceStrategy: {type: "existing_worktree", worktreePath, branch}` (or `root`),
    `threadId: "polaris-<runId>"`, `runtimeMode` from config, `interactionMode: "default"`.
  - Import calls the server route in §2 (`POST /api/polaris/import-session`) with the
    bridge's bearer token.
  - Input uses `orchestration.dispatchCommand` with `message.dispatch`
    (`dispatchMode` `start_immediately` when idle, `queue_after_active` when a run is
    active), `run.interrupt`, `runtime-request.respond`, `thread.model-selection.set`.
    Attachments: `attachments.createUploadUrl`, POST the file bytes, then reference them.
    Images are `image/gif|jpeg|png|webp` up to 10 MB; anything else is a file up to
    50 MB; a file over the limit is refused with `409` naming the file.
  - Every command id and message id is a fresh UUID; record dispatched message ids
    before sending so the echo is never reported as a UI-typed `user.prompt`.
- **Events to polarisd** (table in `CONTRACT.md`), derived from the shell and thread
  streams:
  - A terminal run (`completed`, `interrupted`, `failed`, `cancelled`) → `assistant.completed`
    with the run's final assistant message text (the last assistant message of that run;
    if the run produced several, join only the final message, not the whole run). No
    assistant text and failed → `t3.run.failed`.
  - A runtime request becoming pending → `claude.ask_user_question` (question, with the
    options rendered as `1. …` lines) or `claude.notification` (approval; `text` names
    the tool and its command or path).
  - A user message not dispatched by the bridge → `user.prompt`.
  - After each of these, `POST /v0/runs/{runId}/t3/state` when `turnState`, model,
    effort or title changed.
  - Phone notifications per the contract, when `defaults.phoneNotifications` is true.
- **Adoption.** A thread in the shell stream that is not mapped, is not a subagent
  child (`lineage`/parent set), and whose provider driver is `claudeAgent` or `codex`
  is adopted: `POST /v0/t3/runs/adopt`, then map it. Imported threads created by the
  bridge are already mapped and are not adopted. If polarisd is unreachable, retry with
  backoff; do not drop the thread. Threads that existed before the bridge first ran are
  adopted too.
- **polarisd calls** are retried on network failure and 5xx (bounded backoff, in order
  per run); a 4xx is logged and dropped. Events for one run are delivered in order.
- **Snapshot.** Render from the thread projection's turn items: user messages prefixed
  `> `, assistant text as is, one line per tool item (`⏺ <Tool>: <one-line summary>`),
  pending question/approval as a `? ` block. Tail to `lines`.
- **Logging.** One line per bridge API request and per polarisd event, to stderr, no
  message bodies beyond 80 characters.

### Structure

Keep protocol-free logic pure and unit-tested: input interpretation (the contract's
table), snapshot rendering, event derivation from a sequence of thread/shell stream
items (exactly-once, restart-safe), effort/option mapping, instance selection. The WS
client, HTTP server and polarisd client are thin shells around them.

## 2. `apps/server/src/polaris/`

Both routes use the same auth helper pattern as `apps/server/src/device/DeviceHubProxy.ts`
(`authenticateMediaRequest` / the request authenticator in `apps/server/src/auth/http.ts`)
and require `orchestration:operate` for the import and for non-GET proxy requests,
`orchestration:read` for GET proxy requests. Register each with `HttpRouter.add` and
merge its layer into `layerMakeRoutes` in `server.ts`.

### `POST /api/polaris/import-session`

Body: `{threadId, driver: "claudeAgent"|"codex", instanceId, sessionId, transcriptPath?, projectId, title, worktreePath?, branch?, modelSelection, runtimeMode, createdAt?, lastActivityAt?, settled?}`.

- Model it on `apps/server/src/project/AgentSessionImporter.ts`: build the thread, its
  history and its provider thread and write them through `EventSinkV2.write` with
  `unlessNativeThreadOwned`. Reuse the exported transcript parser in
  `AgentSessionScanner.ts`; do not copy it.
- Differences from the upstream importer: the session is given, not scanned; a session
  whose cwd is a git worktree is accepted; `worktreePath` and `branch` are set on the
  thread; `threadId` is the caller's; history keeps the first user message plus the most
  recent messages up to 400, with a `system_notice` when truncated; `settledOverride` is
  `"settled"` only when `settled` is true.
- When `transcriptPath` is absent, locate the transcript by `sessionId` in the
  instance's Claude projects dir or Codex sessions dir.
- The first message sent to an imported thread must resume the native session
  (`nativeThreadRef`, strength `strong`) and must not also inject a portable handoff of
  the same history. The upstream importer marks threads `historyOrigin: "v1_import"`,
  and `shouldPrepareLegacyImportHandoff` in `Orchestrator.ts` then prepares a handoff.
  Determine whether omitting or changing `historyOrigin` avoids the duplicate while
  keeping the history visible, and prove the result with a test that drives the
  orchestrator (testkit in `apps/server/src/orchestration-v2/testkit`).
- Response: `{threadId, created, messageCount}`; `409` when the session is owned by
  another thread or cannot be found.

### `ANY /api/polaris/proxy/*`

Reverse proxy to `polarisd` (`POLARIS_SERVER` env, default `http://127.0.0.1:43117`)
for the web panels. Only paths under `/v0/` are forwarded. Strip `cookie`,
`authorization` and the WS ticket parameter before forwarding. Stream responses
without buffering so `GET /v0/events/stream` (SSE) works. A down polarisd is `502
{"error"}`.

## 3. Fork tooling

- `docs/polaris/SEAMS.md`: a table of every edit to an upstream file: file, a unique
  marker string that must be present, and why. Format the table so the checker can
  parse it.
- `scripts/polaris/check-seams.ts`: reads `SEAMS.md`, exits non-zero listing any file
  whose marker is missing. Runnable as `node scripts/polaris/check-seams.ts`.
- `docs/polaris/RUNBOOK.md`: how to run the fork server and bridge on the Polaris host
  beside an installed T3 Code (`T3CODE_HOME=~/.t3-polaris`, `T3CODE_PORT`,
  `T3CODE_TELEMETRY_ENABLED=false`, `T3CODE_DISABLE_AUTO_UPDATE`), how to mint the bridge
  token, how to start the bridge, how to merge upstream, how to verify after a merge.
  Follow the documentation rules in `AGENTS.md`: state facts and commands, no narration.

## Acceptance

All must pass; report the exact output tail of each.

1. `vp run --filter @t3tools/polaris-bridge typecheck` and `vp run --filter @t3tools/polaris-bridge test`.
2. `vp run --filter t3 typecheck` and `vp test run apps/server/src/polaris`.
3. `node scripts/polaris/check-seams.ts` exits 0, and exits non-zero when a marker is
   temporarily removed (show both).
4. `git diff --stat main -- . ':!pnpm-lock.yaml'` shows no modified upstream file other
   than `apps/server/src/server.ts`.
5. **Live smoke, free provider.** `node scripts/polaris/smoke.ts` (you write it):
   starts `vp run dev --no-seed --home-dir <temp>` on its own ports, mints a token,
   starts a fake polarisd (an in-process HTTP server that records requests), starts the
   bridge, then through the bridge API: creates a thread on the `Replay (dev)` provider
   in a temp git repo (allow `agent: "replay"` in the bridge behind
   `POLARIS_T3_BRIDGE_ALLOW_REPLAY=1` for this purpose only), sends input, and asserts
   the fake polarisd received exactly one `assistant.completed` for the run with
   non-empty text, that `snapshot` output is non-empty, that a restart of the bridge
   emits no duplicate event, and that a thread created directly over RPC (not through
   the bridge) is adopted exactly once. It stops every process it started, by PID.
6. **Live import, real provider, run once.** Write `scripts/polaris/smoke-import.ts`:
   in a temp git repo with a linked worktree, create a real Claude Code session in the
   worktree (`claude -p --model haiku "Remember the code word: marmalade. Reply OK."`),
   import it through the bridge, assert the thread shows that user message, send
   "What is the code word? Reply with only the word." through the bridge, and assert
   the `assistant.completed` text contains `marmalade`. Then inspect the turn's
   provider input (native event log or the thread's handoff/system items) and report
   whether a portable handoff was injected. Do the same for Codex with its cheapest
   model if `codex` is logged in; if it is not, say so. Report costs or token counts
   if visible. This script is not part of routine checks.
7. `vp run check:changed main` passes, or every failure is listed with the reason it
   is out of scope.

## Report

Finish by writing `docs/polaris/specs/SPEC-A-report.md`: what was built, deviations from
this spec and why, results of each acceptance item, the answers to the three open
questions (does Claude resume when the session cwd is a worktree; does the import avoid
a duplicate handoff; is a bearer header accepted directly on the `/ws` upgrade), and
anything in `CONTRACT.md` that proved wrong or underspecified. Do not edit
`CONTRACT.md`; propose changes in the report.
