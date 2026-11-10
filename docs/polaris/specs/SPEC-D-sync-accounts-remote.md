# Spec D: full sync, accounts, remote links (T3 side)

Read first: `AGENTS.md`, `docs/polaris/README.md`, `docs/polaris/CONTRACT.md` (changed
in this round: input table and `reply`, accounts endpoints, `t3.account.switched`,
public `link`, one-question-at-a-time), and the existing bridge in
`apps/polaris-bridge/src/`. Work on branch `polaris`. Do not commit or push.

You are done only when every acceptance item has been run and passes. Do not stop to
report partial progress.

## Constraints

- Fork rules in `docs/polaris/README.md` § "Staying mergeable" are binding. No new
  edits to upstream files. If one seems unavoidable, write why in
  `docs/polaris/specs/SPEC-D-notes.md` and build the closest thing that needs none.
- Node: put `$HOME/.local/share/vite-plus/js_runtime/node/26.12.1/bin:$HOME/.local/share/vite-plus/bin`
  first on `PATH`. Never touch `~/.t3`. `T3CODE_TELEMETRY_ENABLED=false`.
- A desktop dev app and a demo stack are running from this checkout (`.t3/demo`, server
  on port 13773, bridge on 43918, polarisd on 43917). Do not stop them and do not start
  a dev server on the default ports. For live checks use the smoke scripts, which start
  their own isolated servers on free ports. Kill only PIDs you spawned.

## 1. Restructure the bridge

`apps/polaris-bridge/src/bin.ts` is one 950-line file with five unit tests. Split it
into modules with a pure core: `config.ts`, `state.ts` (durable state + outbox),
`t3Client.ts` (WS RPC session, reconnect, subscriptions), `polarisClient.ts`,
`threads.ts` (create/import/get/stop), `input.ts` (interpretation and dispatch),
`events.ts` (stream → polarisd facts), `accounts.ts`, `snapshot.ts`, `http.ts`
(the loopback API), `bin.ts` (wiring only). Behaviour that exists today must keep
working; the existing smoke scripts are the regression check.

## 2. Input table (contract § `POST /v1/threads/{threadId}/input`)

Implement every row, in order. Details:

- `reply` text is plain text, at most 1,800 characters, no ANSI, readable in Discord
  (short lines, `**bold**` labels allowed, no tables).
- `/model <id-or-alias>`: resolve against the models the thread's provider instance
  offers in server config. Accept an exact slug, a case-insensitive alias the server
  lists, or a unique case-insensitive substring. No match → `409` with the available
  slugs. Apply with `thread.model-selection.set`, keeping the instance and options that
  still apply.
- `/account <profile>`: same as `POST …/account` (§3).
- `/status`: state, model, effort, account label, branch, worktree, link.
  `/usage`: the thread's account usage windows (label, percent used, reset time) and
  the same for the agent's other accounts. `/context`: context-window usage if the
  thread projection exposes it; otherwise say it is unavailable.
- `/clear`: remember per thread (durably) that the next user message is sent with
  `freshContext: true`; if the server does not advertise that capability, refuse with
  `409`. Reply says the next message starts a fresh session.
- `/compact`, `/goal …`, skill invocations and everything else go through as message
  text unchanged.
- Multi-question requests: expose one question at a time as `pendingRequest` and as a
  `claude.ask_user_question` event (stable `eventId` per question index); keep partial
  answers in durable state; respond to T3 with all answers when the last arrives;
  discard partial answers if the request is resolved or dismissed elsewhere (for
  example answered in the T3 client).

## 3. Accounts

The fork supports several Claude and several Codex accounts through T3 provider
instances, without external switcher tools.

Config (`~/.polaris/t3-bridge.json`), replacing `instances`:

```json
{
  "accounts": {
    "autoSwitch": true,
    "switchAtPercent": 97,
    "claude": [
      { "profile": "main", "label": "Main", "default": true },
      {
        "profile": "second",
        "label": "Second",
        "tokenFile": "~/.polaris/accounts/claude-second.token"
      }
    ],
    "codex": [
      { "profile": "main", "label": "Main", "default": true },
      { "profile": "second", "label": "Second", "authHome": "~/.polaris/accounts/codex-second" }
    ]
  }
}
```

With no `accounts` key, each agent has one account, profile `default`, on the built-in
instance (`claudeAgent`, `codex`).

- **Provisioning.** On connect and when the config file changes, the bridge makes the
  provider instances match the config through `server.updateSettings`
  `providerInstanceMutation` (upsert; never remove instances it did not create). The
  account marked `default` uses the built-in instance; each other account is instance
  `<agent>-<profile>` (`claude-second`, `codex-second`).
  - Claude accounts all use the same config directory as the default instance, so they
    share one continuation identity and a thread resumes natively when it moves between
    them. An account's credential is a long-lived OAuth token (from `claude
    setup-token`) read from `tokenFile` and set on the instance as the sensitive
    environment variable `CLAUDE_CODE_OAUTH_TOKEN`. The token never appears in logs,
    bridge state, API responses or error messages. A missing or empty token file marks
    the account `signedIn: false`.
  - Codex accounts use the shared-home arrangement the Codex driver already has:
    `homePath` is the default instance's home, `shadowHomePath` is `authHome`, which
    must contain a real `auth.json` (created by `CODEX_HOME=<authHome> codex login`).
    Missing `auth.json` → `signedIn: false`.
  - Verify in code how each driver computes `continuationIdentity`
    (`apps/server/src/provider/Drivers/ClaudeHome.ts`, `CodexHomeLayout.ts`) and how
    `mergeClaudeProcessEnvironment` orders the deletion of `CLAUDE_CODE_*` variables
    against instance `environment`, and prove with tests against those functions that
    (a) two Claude accounts provisioned this way have equal continuation identities and
    (b) the instance's `CLAUDE_CODE_OAUTH_TOKEN` reaches the provider process
    environment. If (b) is false, record it in `SPEC-D-notes.md` and use the closest
    mechanism that works without an upstream edit.
- **`GET /v1/accounts`, `POST /v1/threads/{id}/account`, `account` in thread GET**, as
  in the contract. `usage` comes from `providers[].usageLimits` in server config;
  refresh with `server.refreshProviders` when a reading is older than 5 minutes and
  something asks for it. `resume` is `native` when the two instances share a
  continuation identity (same driver and same continuation group in server config),
  else `handoff`.
- **Choosing an account for a new thread.** Explicit `accountProfile` wins. Otherwise
  the default account, unless `autoSwitch` is on and its most-used window is at or
  above `switchAtPercent`, in which case the enabled signed-in account whose most-used
  window is lowest.
- **Auto-switch on a usage limit.** When a run ends with a usage-limit failure and
  `autoSwitch` is on: pick the next account of the same agent that is enabled, signed
  in and under `switchAtPercent`; move the thread to it; dispatch one user message
  `Continue where you left off.` (recorded as bridge-dispatched, so it is not reported
  as a UI prompt); post `t3.account.switched` with a one-line `text` such as
  `Claude account Main hit its limit (resets 14:30). Continuing on Second.`. Never
  switch more than once per failed run, never loop (a thread that hits the limit on
  every account stops and reports `t3.run.failed` with the earliest reset time), and
  never switch a thread whose account was set explicitly in the last 10 minutes.
- After any account change send `accountProfile` in `POST /v0/runs/{id}/t3/state`.
- Remove the old `instances` config handling; a config that still has `instances`
  fails at startup with a message naming the new key.

## 4. Links

`link` in every response and event is `<origin>/threads/<environmentId>/<threadId>`
where `<origin>` is, in order: `T3_PUBLIC_ORIGIN` / config `publicOrigin`; the HTTPS
tailnet entry in server config `directEndpoints`; a plain tailnet entry; a LAN entry;
`T3_ORIGIN`. Recompute when server config changes and send the new `link` through
`t3/state` (`link` is accepted there as an extra field) for mapped threads.

## 5. Model handling on create and import

`model` from polarisd may be an alias or a legacy id (`opus`, `claude-fable-5-1`). Apply
the same resolution as `/model`; when nothing matches, use the account's default model
and include `"modelFallback": {"requested", "used"}` in the response instead of failing.

## 6. Proxy scope

`apps/server/src/polaris/Proxy.ts`: non-GET requests require `terminal:operate` in
addition to `orchestration:operate` (the daemon behind the proxy can type into shells).
GET stays `orchestration:read`. Answer CORS preflight (`OPTIONS`) without requiring a
credential, consistent with how the server's other cross-origin routes behave; add tests
for a preflight and for a cross-origin POST carrying a `wsTicket`.

## 7. Agent brief for Codex

polarisd writes a generic agent brief to `~/.polaris/t3-agent-brief.md`. Claude
instances get it through instance `launchArgs` `--append-system-prompt-file <abs path>`.
Find what works for Codex through the instance's `launchArgs` (for example
`-c developer_instructions=…` or an instructions-file option of `codex app-server`) and
prove it with one cheap real turn: put a canary sentence in a temp brief
("If asked for the canary, answer PERSIMMON."), and assert the agent returns it. Do the
same once for Claude. When config `agentBriefFile` is set and the file exists, the
bridge keeps both launch arguments on every account instance it provisions (preserving
other launch arguments), and removes them when the key is unset. Record the mechanism
and the evidence in the report. If no launch-argument mechanism works for Codex, say so
and leave Codex without it.

## Tests

Unit tests for each new pure piece: every input-table row; reply formatting; question
sequencing including resolution elsewhere; account selection and the auto-switch
decision (table-driven: limits, explicit recent choice, all accounts limited, signed
out, disabled); provisioning plan from config (creates, updates, never removes foreign
instances, token never in the serialised plan); link origin precedence; model
resolution. Keep the existing tests passing.

## Acceptance

1. `vp run --filter @t3tools/polaris-bridge typecheck` and `… test`.
2. `vp run --filter t3 typecheck` and `vp test run apps/server/src/polaris`.
3. `node apps/polaris-bridge/scripts/check-seams.ts`; `git diff --stat HEAD -- apps packages`
   shows no upstream file changed.
4. `node apps/polaris-bridge/scripts/smoke.ts` still passes, extended to cover through
   the bridge API: `/status` returns a `reply`; `/model` with an unknown id is refused
   with the list; `/clear` then a message produces a run whose dispatch carried
   `freshContext`; `GET /v1/accounts` lists the provisioned accounts; a second replay
   account can be provisioned and a thread moved to it with `POST …/account`.
5. A live account check, run once: provision a second Claude account whose token file
   contains an invalid token, create a thread on it with the cheapest model, send one
   message, and show that the turn fails with an authentication error (proving the
   instance credential is used, not the host login); then show a thread on the default
   account still works. Delete the test account afterwards.
6. The canary checks in §7, run once each.
7. `vp run check:changed HEAD` passes, or each failure is listed with why it is out of scope.
8. `docs/polaris/specs/SPEC-D-report.md` with results, deviations, and the evidence for
   §3 (a), (b) and §7. Update `docs/polaris/RUNBOOK.md`: accounts setup (`claude
   setup-token`, `codex login` with `CODEX_HOME`), the bridge config keys, running the
   server for remote clients, and pairing a client on another machine.
