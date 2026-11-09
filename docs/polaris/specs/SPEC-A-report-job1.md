# Spec A round 2: Job 1 report

## Import route

`POST /api/polaris/import-session` requires `orchestration:operate` and accepts:

```json
{
  "threadId": "polaris-run-id",
  "driver": "claudeAgent",
  "instanceId": "claudeAgent",
  "sessionId": "native-session-id",
  "transcriptPath": "/absolute/path/to/session.jsonl",
  "projectId": "project-id",
  "title": "Thread title",
  "worktreePath": "/absolute/path/to/worktree",
  "branch": "branch-name",
  "modelSelection": { "instanceId": "claudeAgent", "model": "model-id", "options": [] },
  "runtimeMode": "full-access",
  "createdAt": "2026-09-01T10:00:00.000Z",
  "lastActivityAt": "2026-09-01T10:00:00.000Z",
  "settled": true
}
```

`driver` is `claudeAgent` or `codex`. `transcriptPath`, `worktreePath`, `branch`, `createdAt`, `lastActivityAt`, `settled`, and `modelSelection.options` are optional. `modelSelection.instanceId` must match `instanceId`. Absent a path, discovery uses the selected instance's Claude projects or Codex sessions directory, including configured homes. The endpoint checks the managed runtime-mode ceiling.

Success is HTTP 200 with `{"threadId":"...","created":true,"messageCount":400}`; a repeat for the same thread and native session returns `created:false` and the current thread message count. Missing, unreadable, mismatched, or already-owned sessions return HTTP 409 with `{"error":"..."}`. Invalid input or provider configuration returns 400, a policy refusal returns 403, and persistence failures return 500, each with an `error` string. Auth failures use the server's normal auth responses.

The transcript reader streams files and follows the upstream limits of 4 GiB and 100,000 records. The shared parser retains 200 messages per call; this importer uses batches and retains the first user message and the newest 399, adding a notice when it truncates. Long Codex turns are split at boundaries that keep matching event and response records together. When overlapping matching-record dependencies leave no safe split across more than 199 visible messages, the shared parser cannot retain that section in one call and the import returns 409 rather than silently losing history. This remains a limit of the fork implementation; see SPEC-A-notes.md.

## Native resume and handoff

The imported thread has `historyOrigin: "native"` and a strong `nativeThreadRef`. `shouldPrepareLegacyImportHandoff` requires `historyOrigin: "v1_import"`, so visible imported messages do not cause the legacy handoff. `ImportSession.test.ts` imports 410 messages, dispatches a first message through the real orchestrator and effect worker, and replays a Claude adapter fixture that requires a `query.open` with `resume` set to the native session ID. The run completes, the projection retains the native reference, and both `contextHandoffs` and the run's `contextHandoffId` are empty. This is a replay test, not a paid live Claude session.

## Acceptance results

- `vp run --filter t3 typecheck`: exit 0. Its output ends with existing Effect diagnostic suggestions:

  ```text
  ../../scripts/lib/resolve-catalog.ts(3,67): suggestion TS377141: Add `{ readonly brand: unique symbol }` as the second type argument. Without a brand, TypeScript may accept structurally compatible values where this class instance type is expected. effect(schemaClassMissingBrand)
  ../../scripts/lib/windows-jsign.ts(23,58): suggestion TS377141: Add `{ readonly brand: unique symbol }` as the second type argument. Without a brand, TypeScript may accept structurally compatible values where this class instance type is expected. effect(schemaClassMissingBrand)
  ```

- `vp test run apps/server/src/polaris`: exit 0.

  ```text
   Test Files  2 passed (2)
        Tests  4 passed (4)
     Start at  17:19:29
     Duration  9.20s (transform 53%, import 20%, setup 17%, tests 10%)
  ```

  Tests cover import ownership, sequential and concurrent idempotency, discovery for both drivers including a rewound Codex filename, transcript identity, 400-message truncation for both drivers, long Codex turns with paired and repeated records, route auth and validation, native resume without handoff, proxy scopes, credential stripping, allowlist, incremental SSE, and unavailable upstream.

- `node apps/polaris-bridge/scripts/check-seams.ts`: exit 0, `All 4 Polaris seams present.` A temporary copy of the files with the proxy import marker removed produced `Missing seam: apps/server/src/server.ts (polaris-fork: proxy import)` and exit 1.
- `git diff --stat main -- apps packages ':!apps/polaris-bridge'`:

  ```text
   apps/server/src/server.ts | 4 ++++
   1 file changed, 4 insertions(+)
  ```

- Focused `vp lint` and `vp fmt --check` for Job 1 files passed.

A separate isolated `dev:server` route check returned:

```text
POST import without credentials: 401
POST import with operate scope and invalid body: 400 {"error":"Invalid import request"}
```

The launcher left descendants after its directly spawned wrapper exited. At the time of inspection, the isolated dev-runner was PID 11760, under PID 11750, and the Node watch/server descendants were 11856 and 13563. The temporary home was removed. These PIDs were discovered after spawn and therefore were not signaled under the repository's process-safety rule; they need owner cleanup. No live `~/.t3` state was used.
