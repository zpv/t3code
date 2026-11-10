# Bridge ↔ polarisd contract (v1)

Two loopback HTTP surfaces. All bodies are JSON (`application/json; charset=utf-8`).
Errors are a non-2xx status with `{"error": "<message>"}`; a refused action that the
caller can show to the user uses `409` with `{"ok": false, "reason": "<message>"}`.
Unknown fields are ignored by both sides. Timestamps are ISO 8601 UTC strings.

This file is committed in two repositories and must be identical in both:
`zpv/t3code` `docs/polaris/CONTRACT.md` and `zpv/polaris` `docs/T3_CONTRACT.md`.

## Identity

- `runId`: Polaris run ID. `threadId`: T3 thread ID. For a thread the bridge creates or
  imports on behalf of a run, `threadId` is exactly `polaris-<runId>`.
- A thread created in the T3 UI has an arbitrary `threadId`; `polarisd` assigns it a
  `runId` through `adopt`.
- `agent` is `"claude"` or `"codex"`.

## Bridge API (served by the bridge, default `http://127.0.0.1:43118`)

If `POLARIS_T3_BRIDGE_TOKEN` is set, every request must carry
`Authorization: Bearer <token>`.

### `GET /v1/health`

`200 {"ok": true, "t3": {"connected": bool, "origin": string, "environmentId": string|null}, "polaris": {"server": string}}`

### `POST /v1/threads` (create a thread for a new run)

Request:

```json
{
  "runId": "run_...",
  "agent": "claude",
  "title": "fix-login",
  "repoPath": "/abs/project/repo",
  "projectTitle": "bws-app",
  "worktreePath": "/abs/worktree",
  "branch": "steven/fix-login",
  "model": "claude-opus-5-5",
  "effort": "high",
  "accountProfile": "main",
  "initialMessage": "optional first prompt"
}
```

`worktreePath`, `branch`, `model`, `effort`, `accountProfile`, `projectTitle` and
`initialMessage` are optional. Without `accountProfile` the bridge picks the agent's
default account, or, when account auto-switching is on, the enabled signed-in account
with the most headroom. `link` is a URL that opens the thread from another machine on
the tailnet (the server's advertised tailnet or HTTPS origin, or the bridge's configured
public origin), never a loopback address unless nothing else exists. Without `worktreePath` the thread runs in `repoPath`.
The bridge finds or creates the T3 project rooted at `repoPath`, and creates the thread
bound to the existing worktree (it never creates or removes worktrees).

`201 {"threadId", "environmentId", "link"}`. Idempotent on `runId`: a repeat returns
`200` with the same body and sends no second `initialMessage`.

### `POST /v1/threads/import` (import an existing native session)

Request: the create fields without `initialMessage`, plus

```json
{
  "sessionId": "native Claude/Codex session id",
  "transcriptPath": "/abs/path/to/session.jsonl",
  "createdAt": "...",
  "lastActivityAt": "...",
  "settled": true
}
```

`transcriptPath` is optional (the server locates the transcript by `sessionId` when it
is absent). The thread shows the session's user and assistant messages, is bound to
`worktreePath`, and its next message resumes the same native session.

`200 {"threadId", "environmentId", "link", "created": bool, "messageCount": int}`.
Idempotent on `runId`; `created` is false when the thread already existed.
`409 {"ok": false, "reason"}` when the session cannot be found or is owned by another thread.

### `POST /v1/threads/{threadId}/input`

Request: `{"input": string, "mode": "task"|"raw", "attachments": [{"path": "/abs/file", "name": "optional"}], "inputId": "optional idempotency key"}`.
When `inputId` is given, a repeat with the same `inputId` for the same thread performs nothing and returns the original response; the bridge remembers keys durably for at least 7 days. `polarisd` uses this to retry safely and to deliver input it queued while the bridge was unreachable.
`mode` defaults to `"task"`; `attachments` is optional (host paths; the bridge uploads
images and files to T3 as real attachments).

Interpretation, first match wins:

| Input                                                                                          | Action                                                                                                                                       | `delivery`                                           |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Only magic-key tokens containing `$esc` or `$cc` (alias `$ctrl-c`)                             | Interrupt the active run                                                                                                                     | `"interrupted"` (or `"idle"` if nothing was running) |
| Any other input made only of `$`-prefixed magic-key tokens                                     | Refuse                                                                                                                                       | `409`, reason says T3 threads have no terminal keys  |
| A pending question exists and the input is a 1–2 digit number                                  | Answer the current question with that option (1-based)                                                                                       | `"answered"`                                         |
| A pending question exists and the input is other text                                          | Answer the current question with the text as a free-form reply                                                                               | `"answered"`                                         |
| A pending approval exists and the input is `y`, `yes`, `approve`, `1` / `n`, `no`, `deny`, `2` | Accept / decline                                                                                                                             | `"answered"`                                         |
| `/model`                                                                                       | Reply with the current model and the models available to the thread's account                                                                | `"replied"`                                          |
| `/model <id-or-alias>`                                                                         | Set the thread's model; an id the account does not offer is refused with the list                                                            | `"configured"`                                       |
| `/effort` / `/effort <level>`                                                                  | Reply with the current effort and allowed levels / set it                                                                                    | `"replied"` / `"configured"`                         |
| `/account` / `/account <profile>`                                                              | Reply with the thread's account and the others available / move the thread to that account                                                   | `"replied"` / `"configured"`                         |
| `/status`, `/usage`, `/context`                                                                | Reply with thread status (state, model, effort, account, branch, link), the account's usage windows, or context usage. Not sent to the agent | `"replied"`                                          |
| `/clear`                                                                                       | The next user message starts a fresh provider session (T3 `freshContext`)                                                                    | `"configured"`                                       |
| Anything else, including `/compact`, `/goal …` and skill invocations                           | Send as a user message; starts a run, or queues behind the active run                                                                        | `"started"` or `"queued"`                            |

A request with several questions is presented one question at a time: the bridge
collects each answer and responds to T3 when the last one is answered.

`200 {"ok": true, "delivery", "messageId": string|null, "reply": string|null}`. `reply`
is text for the person who sent the input (shown by Discord and the CLI); it is set for
`"replied"` and may be set for `"configured"`. The request returns when T3 has accepted
the command, not when the turn finishes. `409 {"ok": false, "reason"}` on refusal.

### `POST /v1/threads/{threadId}/stop`

Interrupts any active run and stops the provider session. `200 {"ok": true}`. The
thread stays resumable.

### `GET /v1/threads/{threadId}`

```json
{
  "threadId": "...",
  "environmentId": "...",
  "link": "...",
  "title": "...",
  "agent": "claude",
  "turnState": "working|idle|waiting|failed|unknown",
  "model": "...",
  "effort": "...",
  "account": { "id": "provider instance id", "profile": "main", "label": "Main" },
  "worktreePath": "...",
  "branch": "...",
  "nativeSessionId": "... or null",
  "pendingRequest": { "id": "...", "kind": "question|approval", "text": "...", "options": ["..."] }
}
```

`pendingRequest` is null when nothing is pending. `404` when the thread does not exist.

### `POST /v1/threads/{threadId}/account`

Request `{"profile": string}`. Moves the thread to that account's provider instance.
`200 {"ok": true, "account": {"id", "profile", "label"}, "resume": "native"|"handoff"}`:
`native` when the next message resumes the same provider session under the new account,
`handoff` when T3 starts a new session from a summary. `409` for an unknown, disabled or
signed-out account.

### `GET /v1/accounts`

```json
{
  "autoSwitch": true,
  "accounts": [
    {
      "id": "claude-main",
      "agent": "claude",
      "profile": "main",
      "label": "Main",
      "enabled": true,
      "signedIn": true,
      "default": true,
      "usage": {
        "checkedAt": "...",
        "windows": [{ "label": "5h", "usedPercent": 41, "resetsAt": "..." }]
      }
    }
  ]
}
```

`usage` is null when T3 has no reading. `signedIn` is null when unknown.

### `GET /v1/threads/{threadId}/snapshot?lines=N`

`200 {"output": string}`: a plain-text rendering (no ANSI) of the tail of the thread's
activity, at most `N` lines (default 200), oldest first. It is what Discord shows as the
live preview, so while a run is active it must change as the agent works: assistant text
so far, and one line per tool action (`⏺ Bash: <command>`, `⏺ Edit: <path>`, …).

## polarisd API used by the bridge (default `http://127.0.0.1:43117`)

### `POST /v0/runs/{runId}/events` (existing)

`{"type", "source": "t3-bridge", "payload": {...}}`. The bridge emits:

| `type`                     | When                                                                                                                            | `payload`                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3.run.started`           | A run starts in the thread, whichever surface sent the message                                                                  | `{"t3RunId", "origin": "polaris" or "t3"}`; `origin` is `polaris` when the message came through the bridge `input` endpoint                       |
| `user.prompt`              | A user message appears in the thread that did **not** come through the bridge's `input` endpoint (typed in the T3 UI or mobile) | `{"text", "messageId", "origin": "t3"}`                                                                                                           |
| `assistant.completed`      | A run reaches a terminal state with a final assistant message                                                                   | `{"text", "t3RunId", "status": "completed                                                                                                         | interrupted | failed"}` |
| `claude.ask_user_question` | A question becomes pending                                                                                                      | `{"text", "requestId", "options": ["..."], "notification_type": "ask_user_question"}`; `text` is the question followed by a numbered option list  |
| `claude.notification`      | An approval becomes pending                                                                                                     | `{"text", "requestId", "notification_type": "permission_prompt"}`                                                                                 |
| `t3.run.failed`            | A run fails without assistant text                                                                                              | `{"text": "<error>", "t3RunId"}`                                                                                                                  |
| `t3.account.switched`      | The thread moved to another account (auto-switch after a usage limit, or on request)                                            | `{"text": "<one line for people>", "from": "<profile>", "to": "<profile>", "reason": "usage_limit" or "manual", "resume": "native" or "handoff"}` |

Every event the bridge posts carries a top-level `eventId` string that is stable for the
underlying T3 fact (for example `t3:<threadId>:run:<t3RunId>:terminal`,
`t3:<threadId>:request:<requestId>`, `t3:<threadId>:message:<messageId>`). `polarisd`
treats `(runId, eventId)` as an idempotency key, checked in the same transaction that
writes the event: a repeat returns `200` with the original event and writes nothing.
The bridge retries until acknowledged, so each fact is recorded exactly once, including
across bridge crashes and restarts. Events without `eventId` (from other sources) are
never deduplicated.

### `POST /v0/t3/runs/adopt`

For a thread the bridge did not create (made in the T3 UI). Request:

```json
{"threadId", "environmentId", "link", "agent", "title", "repoPath", "worktreePath": "... or null", "branch": "... or null", "model": "... or null", "effort": "... or null", "createdAt"}
```

`polarisd` creates a run with `backend: "t3"`, resolving the project by `repoPath` and
the workspace by `worktreePath` when they are registered. `201 {"run": {...}}`;
idempotent on `threadId` (`200` with the existing run). The bridge then uses `run.id`
for events.

### `POST /v0/runs/{runId}/t3/state`

Request: any subset of `{"turnState", "model", "effort", "title", "nativeSessionId", "accountProfile", "archived": bool, "deleted": bool}`.
`polarisd` updates the run and emits `run.updated`. `archived` or `deleted` marks the run
stopped. `200 {"run": {...}}`.

### `POST /v0/notifications/phone` (existing)

The bridge sends `{"kind": "done", "body", "runId", "source": "t3-bridge"}` after an
`assistant.completed` and `{"kind": "input-needed", ...}` after a question or approval.

## Run identity for agents started by T3

T3 exports `T3CODE_THREAD_ID` to Claude processes (and everything they spawn) and to
Codex shell commands. `GET /v0/runs/resolve?t3ThreadId=<id>` returns the run for that
thread (`404` when unknown); `GET /v0/runs/resolve?cwd=<abs>` remains the fallback.
