# Spec E: closing the gaps (three parallel jobs)

Read first: `AGENTS.md`, `docs/polaris/README.md`, `docs/polaris/CONTRACT.md` (new this
round: `t3.run.started`, `inputId`), `docs/polaris/SEAMS.md`. Work on branch `polaris`.
Do not commit or push.

Three agents work in this checkout at the same time, one per job below. Touch only the
paths your job owns. You are done only when every acceptance item for your job has been
run and passes. Do not stop to report partial progress.

Rules for all jobs:

- Node: put `$HOME/.local/share/vite-plus/js_runtime/node/26.12.1/bin:$HOME/.local/share/vite-plus/bin`
  first on `PATH`. Never read-write or start anything against `~/.t3`.
  `T3CODE_TELEMETRY_ENABLED=false`.
- A desktop dev app and demo stack run from this checkout (`.t3/demo`; ports 13773,
  5733, 43917, 43918). Never stop or restart them; never start a dev server on default
  ports; use isolated homes and free ports. Kill only PIDs you spawned.
- Edits to upstream files are seams: one or two lines each, a `// polaris-fork: <name>`
  comment, a row in `docs/polaris/SEAMS.md` (append rows; do not reorder others' rows),
  logic in fork-owned files. Only the seams a job lists are permitted. If another seems
  unavoidable, write why in `docs/polaris/specs/SPEC-E-notes-<job>.md` and build the
  closest thing without it.
- Follow `docs/internals/web-ui.md` for web code (primitives, Tailwind, React Compiler,
  no `useMemo`/`useCallback`).

## Job 1: bridge (`apps/polaris-bridge/**`)

1. **`t3.run.started`.** Emit it once per run (stable `eventId`) when a run starts in a
   mapped thread, with `origin: "polaris"` when the triggering message was dispatched
   through the bridge `input` endpoint, else `"t3"`.
2. **`inputId`.** Implement the idempotency key exactly as the contract says (durable,
   per thread, at least 7 days, pruned; a repeat returns the stored response and
   dispatches nothing), including when the first attempt's response was lost after T3
   accepted the command.
3. **`scripts/merge-upstream.ts`** (run from the repository root). Steps: refuse to run
   on a dirty tree or when not on `polaris`; `git fetch upstream`; fast-forward `main`
   to `upstream/main` (using `git fetch upstream main:main` so no checkout is needed);
   if `main` is already merged into `polaris`, print `up to date` and exit 0;
   `git merge --no-edit main`. On conflict: for `pnpm-lock.yaml` and
   `apps/web/src/routeTree.gen.ts` take upstream's version and regenerate (`vp i`; the
   route tree by running the web typecheck/build step that generates it: find the exact
   command); any other conflict → `git merge --abort`, print the conflicted files, exit 2. Then verify: `vp i`, `node apps/polaris-bridge/scripts/check-seams.ts`,
   typecheck of `@t3tools/polaris-bridge`, `t3` and `@t3tools/web`, tests for the bridge
   and `apps/server/src/polaris` and `apps/web/src/polaris`, and
   `node apps/polaris-bridge/scripts/smoke.ts`. Any verification failure →
   `git reset --hard` to the pre-merge commit, print which step failed with its last 20
   lines, exit 3. On success: `git push origin main polaris` unless `--no-push`, print
   one summary line (`merged N upstream commits; all checks passed`), exit 0. Flags:
   `--no-push`, `--dry-run` (stop after reporting how many commits would merge).
   The final line of output is always a one-line human summary.
4. Tests: `t3.run.started` origin and exactly-once across restart; `inputId` replay
   (including lost-response case) and pruning; merge script logic that can be unit
   tested without network (conflict classification, summary lines), plus one real run
   of the script with `--dry-run`.

Acceptance (Job 1): bridge typecheck and tests; `node apps/polaris-bridge/scripts/smoke.ts`
passes and now asserts one `t3.run.started` per run with the right origin, and that a
repeated `inputId` produces one message; `node apps/polaris-bridge/scripts/merge-upstream.ts --dry-run`
prints a summary; `vp run check:changed HEAD`; report in
`docs/polaris/specs/SPEC-E-report-job1.md`.

## Job 2: web (`apps/web/src/polaris/**`, `apps/web/src/routes/_chat.polaris.tsx`)

Permitted seams: one line in `apps/web/src/routes/__root.tsx` mounting `<PolarisHost />`
beside the other headless hosts; one or two lines where the web client decides whether
to offer worktree removal on thread delete (`apps/web/src/worktreeCleanup.ts` or its
caller in `apps/web/src/hooks/useThreadActions.ts`), calling a predicate from
`apps/web/src/polaris/`.

1. **Worktree guard.** When a thread is deleted, the client must not offer to remove a
   worktree that T3 did not create: a worktree path outside T3's managed worktrees
   directory (and its previous directories) is never offered for removal. Find what the
   client already knows about the managed directory (server config / settings); if it
   knows nothing, the predicate asks Polaris (`/api/polaris/proxy/v0/runs/resolve?cwd=`)
   and refuses when the path belongs to a Polaris workspace, and when Polaris is
   unavailable falls back to today's behaviour. Unit-test the predicate.
2. **Close workspace from the Polaris page.** Runs tab: a workspace-level action
   (`Close workspace…`) on any run that has a workspace: dialog with the two modes
   (`Merge into <default branch>` / `Abandon`), options `Push` and `Delete branch`, a
   dry-run preview from `POST /v0/workspaces/{id}/close` with `dryRun: true` showing the
   planned operations and any blocking reason, then confirm. Destructive styling for
   Abandon. Same dialog rules as the migration dialog (no dismissal while in flight,
   focus returns to trigger, results listed).
3. **Brief tab.** Fourth tab `Brief`: runs that need you, from `GET /v0/brief`. One card
   per run with open items: run name (links to the thread or the run row), state dot,
   one-line headline, then its open items as rows: title, quote in muted text
   (two-line clamp), age, and actions `Done` (resolve), `Dismiss`, `Snooze 1h / until
   tomorrow` (PATCH `/v0/brief/runs/{id}/items/{itemId}`). Items owned by the agent are
   hidden behind a `Show agent activity` switch (default off). Header shows provider
   pause state when `providerRetryAt` is set and a `Refresh` button
   (`POST /v0/brief/refresh`). Empty state: "Nothing needs you." Refetch on
   `brief.updated` / `brief.item.updated` events. When Brief is disabled on the host
   (`enabled: false`), the tab shows that in one sentence.
4. **Phone actions.** Run row menu: `Send link to phone` (exists), plus for runs with a
   workspace `Send Metro opener to phone` and `Open dev client on iPhone`
   (`POST /v0/dev-client/launcher`, then `POST /v0/notifications/phone` with `kind:
   "metro"` and the launcher's public URL / show the deep link); and `Show QR code` for
   the thread link and for a launcher URL: a dialog with a QR code rendered locally
   (find an existing QR dependency or renderer in the repo, for example what the pairing
   UI uses; do not add a network call), the URL beneath it, and a copy button.
5. **Completion sound.** `PolarisHost` (headless, mounted at the root) plays a short
   chime when a thread stops working and is waiting for you: a transition of a
   top-level (non-subagent) thread from an active run to idle-with-a-reply or to a
   pending question/approval, observed from the client's existing shell state. Not for
   threads you are currently viewing while the window is focused; at most one chime per
   2 s; nothing on initial load or reconnect. The chime is synthesised with Web Audio
   (no asset file): three notes E5 → G5 → C6, each 90 ms, square wave mixed with a
   quieter triangle an octave below, 6 ms attack and 60 ms release per note, one echo at
   80 ms delay and 0.3 gain, master gain from a volume setting. A different two-note
   falling figure (G5 → E5) for "needs input". Settings in the Polaris page header
   overflow menu: `Completion sound` on/off (default on) and volume (three steps),
   persisted in client storage with the repo's existing client-persistence helper, plus
   a `Test sound` item. Browsers block audio before a user gesture: unlock on the first
   pointer or key event and stay silent until then. The reference implementation is
   `~/Documents/Agent Orchestration Worktrees/polaris-client/client/src/sound.rs`
   (read-only).
6. Tests (logic only): worktree predicate; brief grouping and filtering; chime trigger
   decision (table-driven over state transitions, focus, rate limit, initial load);
   note schedule generation; QR input selection.
7. Screenshots at 1440×900 light and dark into `.t3/demo/shots-e/`: Brief tab with at
   least two runs and items (seed through the demo polarisd; if Brief cannot produce
   items without its model provider, POST manual items or use the fixture path the Go
   tests use, and say which), the close-workspace dialog after a dry run, the QR dialog,
   the settings menu. Inspect them yourself and fix misalignment, clipping, contrast and
   inconsistency with the existing Polaris tabs. The demo web client is the desktop dev
   app's renderer at `http://127.0.0.1:5733` (pair with
   `node apps/server/src/bin.ts pair --base-dir .t3/demo/t3home`); Playwright usage as in
   `.t3/demo/shot.mjs`.

Acceptance (Job 2): `vp run --filter @t3tools/web typecheck`; `vp test run apps/web/src/polaris`
and `vp test run apps/web/src/reactCompilerCoverage.test.ts`; `check-seams.ts`;
`git diff --stat HEAD -- apps/web` shows among upstream files only `__root.tsx`, the one
worktree-cleanup file, and `routeTree.gen.ts` if regenerated; the screenshots; report in
`docs/polaris/specs/SPEC-E-report-job2.md`.

## Job 3: desktop identity and packaging (`apps/desktop/**`, `scripts/**`, `packages/shared/src/forkIdentity.ts`)

Goal: an installable macOS app built from this fork that runs beside an installed
official T3 Code without sharing anything with it.

1. `packages/shared/src/forkIdentity.ts` (new, fork-owned): the single source of
   identity: product name `Polaris`, bundle/app id `sh.zpv.polaris.t3`, dev variants,
   protocol schemes `polaris-t3` and `polaris-t3-dev`, Electron userData directory
   names, the default T3 home directory name `.polaris-t3` (so the default data
   directory is `~/.polaris-t3`, never `~/.t3`), auto-update disabled, telemetry
   disabled by default, release source none.
2. Replace the corresponding upstream literals with imports of those constants, one
   seam per literal, in the files that define them: `scripts/build-desktop-artifact.ts`
   (app id, product name, schemes, artifact names), `apps/desktop/src/electron/ElectronProtocol.ts`,
   `apps/desktop/src/app/DesktopUserData.ts`, `apps/desktop/src/app/DesktopEnvironment.ts`
   (app name, AppUserModelID), `apps/server/src/httpCors.ts` (allowed app origins: add
   the fork schemes, keep upstream's), `packages/shared/src/remote.ts` (pairing app
   link scheme), `apps/server/src/os-jank.ts` (default home), `apps/web/src/branding.ts`
   (base name), the telemetry default in `apps/server/src/telemetry/AnalyticsService.ts`,
   and the auto-update default in `apps/desktop/src/updates/DesktopUpdates.ts`. Find the
   exact lines; keep each seam to the literal. Where upstream already has an environment
   override, prefer setting the default through the same code path. List every seam in
   `SEAMS.md`. Explicit env overrides (`T3CODE_HOME`, `T3CODE_TELEMETRY_ENABLED`, …) keep
   working and win.
3. **Thread deep links.** The packaged app handles `polaris-t3://thread/<environmentId>/<threadId>`
   by focusing the window and navigating to that thread (and `polaris-t3://polaris`
   by opening the Polaris page). Implement in fork-owned files with at most one seam
   where the desktop app dispatches protocol URLs and, if needed, one where the renderer
   receives navigation requests. `open "polaris-t3://thread/…"` from a terminal must
   work when the app is running and when it is not.
4. **Build.** `vp run dist:desktop:dmg:arm64` (or the artifact script with the right
   flags) produces an unsigned arm64 app named `Polaris`. Fix what blocks an unsigned
   local build without Apple credentials (ad-hoc signing is acceptable; notarization is
   out of scope). Record the exact command, duration and output path. Install nothing
   system-wide; leave the artifact under `release/`.
5. **Prove coexistence** on this machine without touching `~/.t3` or the installed
   `/Applications/T3 Code.app`: launch the built app with `open -n <path>` , then show:
   its bundle identifier (`mdls`/`defaults read`), that its data directory is
   `~/.polaris-t3` (created) while `~/.t3` modification times are unchanged, its
   Electron userData directory name, that it registered the `polaris-t3` scheme, that no
   telemetry or update request left the machine (server/desktop logs: analytics client
   disabled, updater disabled), and that a thread deep link opens it. Quit it by the PID
   you launched.
6. Tests: unit tests for the identity module consumers where they exist upstream
   (update expectations, do not delete tests); a test that greps the built app's
   `Info.plist` for the id, name and scheme.

Acceptance (Job 3): typecheck of `@t3tools/desktop`, `t3`, `@t3tools/shared`,
`@t3tools/web`; affected tests; `check-seams.ts`; the build and the coexistence evidence;
`vp run check:changed HEAD`; report in `docs/polaris/specs/SPEC-E-report-job3.md`
listing every seam added and the artifact path.
