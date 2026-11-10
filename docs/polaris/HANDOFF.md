# Handoff: Polaris integration for T3 Code (parked 2026-11-10)

This branch (`polaris`) holds a fork of T3 Code that makes it the client and
conversation runtime for [Polaris](https://github.com/zpv/polaris). Work stopped on
2026-11-10 in favour of running vanilla T3 Code beside Polaris. Nothing here is
deployed. The Polaris half is on branch `archive/t3-backend` of `zpv/polaris`
(`docs/T3_HANDOFF.md` there).

Read `docs/polaris/README.md` for the design and `docs/polaris/CONTRACT.md` for the
wire contract between the bridge and `polarisd`.

## State of the branch

The last commit, "WIP: spec E jobs, stopped mid-run", is unreviewed work from three
jobs that were interrupted. Everything before it was reviewed and had passing checks at
the time it was committed.

| Piece | Location | State |
| --- | --- | --- |
| Bridge (headless WS client of T3, loopback HTTP API for `polarisd`) | `apps/polaris-bridge/` | Reviewed through "split into modules, durable account switching". Unit tests, a replay-provider smoke (`scripts/smoke.ts`) and a real-agent import check (`scripts/smoke-import.ts`) passed. |
| Session import with visible history | `apps/server/src/polaris/ImportSession.ts` | Reviewed. Imports a Claude or Codex session into a thread bound to an existing worktree; the next message resumes the native session with no duplicate handoff. Verified with real Claude and Codex sessions. |
| Authenticated proxy to `polarisd` | `apps/server/src/polaris/Proxy.ts` | Reviewed. |
| Polaris page (runs, resources, devices, migration dialog) | `apps/web/src/polaris/`, `apps/web/src/routes/_chat.polaris.tsx` | Reviewed; Runs and migration screens inspected, the rest not. |
| Accounts (one provider instance per account, auto-switch on usage limit) | `apps/polaris-bridge/src/accounts.ts`, `switch.ts` | Reviewed against fakes. A Claude instance with an invalid `CLAUDE_CODE_OAUTH_TOKEN` failed authentication, showing the per-instance token is used. Two real accounts were never tested. |
| Spec E job 1: `t3.run.started`, `inputId`, `scripts/merge-upstream.ts` | `apps/polaris-bridge/` | **WIP, unreviewed.** Its report (`specs/SPEC-E-report-job1.md`) says checks passed. |
| Spec E job 2: worktree guard, close workspace, Brief tab, phone actions, QR, completion sound | `apps/web/src/polaris/` | **WIP, unreviewed, interrupted.** No report. |
| Spec E job 3: desktop identity (`Polaris`, `sh.zpv.polaris.t3`, `~/.polaris-t3`), thread deep links, packaged build | `packages/shared/src/forkIdentity.ts`, `apps/desktop/`, `scripts/` | **WIP, unreviewed, interrupted.** It produced an unsigned `Polaris-0.1.7-arm64.dmg` that was never opened by a reviewer. No report. |

Specs and job reports are in `docs/polaris/specs/`. `SPEC-E-gaps.md` describes the
interrupted round.

## Facts worth keeping

- **Fork footprint.** Before spec E the fork edited 3 upstream files (8 marked lines)
  plus the generated route tree; `docs/polaris/SEAMS.md` lists every seam and
  `apps/polaris-bridge/scripts/check-seams.ts` verifies them. Spec E job 3 adds identity
  seams in about ten more upstream files.
- **Staying mergeable.** `main` mirrors `upstream/main`; `polaris` merges from it. One
  trivial merge was done. Upstream lands about 150 commits a day; at the time of
  parking `polaris` was 35 commits behind.
- **Run identity.** T3 exports `T3CODE_THREAD_ID` to Claude processes and Codex shell
  commands (upstream behaviour).
- **Agent instructions.** Claude instances accept `--append-system-prompt-file <path>`
  in `launchArgs`; Codex accepts `-c developer_instructions=<TOML string>`. Both were
  confirmed with a live turn.
- **Accounts.** T3 resumes a thread natively across provider instances only when their
  continuation identity matches: for Claude that is the resolved config directory path,
  for Codex the shared home. Several Claude accounts on one config directory, each with
  its own `CLAUDE_CODE_OAUTH_TOKEN` in instance `environment`, share an identity. Codex
  has shared-home plus `shadowHomePath` built in.
- **Slash commands.** `/compact` is handled by T3 for both providers. `/clear` maps to
  `freshContext: true` on the next message. Other slash text passes to the provider.
- **Remote access.** A server started with `--lan` is reachable over the tailnet on
  plain HTTP. Browsers upgrade hostnames to HTTPS, so use the tailnet IP or
  `tailscale serve` (needs root). `localhost` through an SSH tunnel connects but the
  client's loopback timing can make it reconnect a few times first.
- **Host constraint.** On the Polaris host, launchd agents hang reading the external
  volume; services run under SSH (tmux or the Polaris SSH supervisor).

## Known gaps at the time of parking

- Discord was never exercised against a real bot; the Discord daemon changes have unit
  tests only.
- Nothing was deployed with the new `polarisd`; no real run was migrated through it.
- The desktop app was only ever run as a dev build, which relaunches itself and breaks
  when its checkout is edited. Do not hand a dev build to anyone for testing.
- Deleting a thread in the T3 client can remove a worktree T3 did not create (the
  guard in spec E job 2 is unreviewed).
- Long Codex transcripts: import keeps the first message and the latest 399; one rare
  transcript shape is refused (`specs/SPEC-A-notes.md`).

## Picking it up again

1. `git fetch upstream && git checkout main && git merge --ff-only upstream/main`, then
   merge `main` into `polaris` and run the checks in `docs/polaris/RUNBOOK.md`.
2. Review or discard the WIP commit job by job.
3. Deploy order and the cutover plan are in the Polaris repo's `docs/T3_HANDOFF.md`.

The toolchain is Vite+ (`vp`); Node comes from `vp env exec --node 26.12.1`, not the
system Node. The `vp` installer edits shell startup files; remove the lines it adds on
any shared host.
