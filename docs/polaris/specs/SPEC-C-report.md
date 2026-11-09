# Spec C implementation report

The Polaris route provides Runs, Resources and Devices views, an environment selector, migration dry runs and results, shell snapshots and input, and the sidebar and palette entry points. Requests use the environment's authenticated media access and renew remote tickets. The page reads the event stream with a resumable cursor, refreshes affected collections, and retains stale data on failure.

## Deviations and verification limits

- The upstream chat layout only retains its existing chat for routes named by `isAppModalPage`. That helper is outside the permitted seams. Polaris renders the previous thread underneath its sheet, but that thread remounts when opening Polaris. See `SPEC-C-notes.md`.
- The demo server's proxy defaulted to port 43117 while the isolated daemon was on 43917. A loopback TCP forwarder was started on 43117 and left running so the existing demo continues to work. The daemon, bridge and Vite listener were not deliberately restarted or replaced.
- The required test commands generated files under `packages/client-runtime/node_modules/.vite-temp`. The already-running server's file watcher detected those files and automatically restarted its Node server process several times, despite the instruction to keep the stack running. The runner, Vite and daemon remained running; the server is listening again on port 13775. No manual restart was performed.
- Browser verification used the spec's Playwright executable because the T3 Browser panel tools were unavailable. The demo had no simulator lease or tunnel; their empty states were inspected, while populated simulator and tunnel operations and remote environment authentication were not exercised against a live remote host. A migration on the fake session was not applied. The in-flight guard and result link were exercised using an intercepted response.

## Acceptance results

1. `vp run --filter @t3tools/web typecheck`: passed.
2. `vp test run apps/web/src/polaris`: 3 tests passed. `vp test run apps/web/src/reactCompilerCoverage.test.ts`: 1,361 tests passed.
3. `vp lint` on the Polaris files, route, and two edited upstream components: passed. `node apps/polaris-bridge/scripts/check-seams.ts`: 8 seams passed.
4. `git diff --stat HEAD -- apps packages` lists only the two permitted upstream components and regenerated `routeTree.gen.ts`. New Polaris files are untracked and therefore do not appear in that command's diff.
5. The screenshots below were captured and visually inspected. The light and dark Runs views include two projects, tmux and T3 agent runs, and a live expanded shell snapshot. The migration capture is a dry run.
6. `vp run check:changed HEAD`: passed format, lint, both knip checks, affected typechecks, tests and React Compiler checks. This run preceded the final accessible state label and Discord icon; lint and web typecheck passed again afterward. The full check was not repeated because its test runner causes the running server watcher to restart. Playwright's matching browser was installed after the first run reported it missing.

The interactive pass also checked search, live snapshot refresh, migration dry-run options, Escape and focus return, arrow navigation, a cancelled stop confirmation, URL tab state, stale-data retry, and sidebar open/close.

## Screenshots

All paths are under `.t3/demo/shots/`:

- `runs-light.png`, `runs-dark.png`
- `migration-light.png`, `migration-dark.png`
- `resources-light.png`, `resources-dark.png`
- `devices-light.png`, `devices-dark.png`
- `mobile.png`, `mobile-dark.png` (390 × 844)
- `sidebar.png`, `sidebar-dark.png`
- `palette.png`, `palette-dark.png`

The remaining screenshots are 1440 × 900.
