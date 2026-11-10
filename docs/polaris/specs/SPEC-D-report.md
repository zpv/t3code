# Spec D implementation report

## Verification

- Bridge typecheck and tests passed. Server `t3` typecheck and `vp test run apps/server/src/polaris` passed; the latter includes the Claude home and process-environment check below.
- `check-seams.ts` passed with all 8 seams present. Changes under `apps/` are confined to fork-owned Polaris paths.
- The extended isolated replay smoke passed, including `/status`, unknown `/model`, `/clear` with a projected `freshContext` run, account listing, and moving to a second replay instance. Evidence: `/var/folders/yx/3lbxv4sn1wgf4n9gf5mm9_340000gn/T/polaris-smoke-LML2mo`.
- `vp run check:changed HEAD` passed after the final code changes.
- An isolated live check provisioned a Claude instance with an invalid token. Its turn failed with an authentication error. A default-account Haiku turn and a Codex Luna turn each returned `PERSIMMON` from the temporary brief. The isolated settings file and bridge state no longer contained the test account; the dummy token appeared in neither bridge state nor the smoke log. Evidence: `/var/folders/yx/3lbxv4sn1wgf4n9gf5mm9_340000gn/T/polaris-smoke-PnFWFD`. The combined live smoke later failed its replay stage because the isolated dev server reloaded during concurrent source edits; the separate replay run above passed.

## Provider mechanisms

`ClaudeDriver` calls `makeClaudeContinuationGroupKey` using the resolved Claude home, so instances with the same home share the same continuation key. `mergeClaudeProcessEnvironment` removes inherited host session variables before merging the instance environment. `AccountHomes.test.ts` exercises both functions and verifies that the account's `CLAUDE_CODE_OAUTH_TOKEN` survives that merge.

Claude's launch argument is `--append-system-prompt-file <path>`. Codex's app-server launch arguments carry `-c developer_instructions=<TOML string>` containing the brief. The isolated live turns above exercised those provisioned launch arguments.

## Round 2

The bridge now separates account provisioning, thread operations, input dispatch, event delivery, HTTP routing, and the WebSocket lifecycle into their respective modules. The entry point delegates wiring to `bridge.ts`.

Auto-switch persists its intent and stable command and event IDs before moving the thread. Recovery retries the move and continuation through T3's command receipts and the switch event through polarisd's event-id deduplication. If the target is unavailable or the thread has moved elsewhere, the bridge abandons the intent and reports the failed run. Removed accounts remain listed as disabled and retain their provider instance while a thread uses them. Config reload retries failed provisioning.

The bridge tests cover the switch recovery boundaries, an unavailable target, all accounts limited, a failed provisioning call followed by success, and removal of an account in use. The isolated replay smoke exercised a web-origin RPC message, checked that bridge input does not produce a `user.prompt`, answered the `showcase` approval and the `question` elicitation through the bridge, and observed both runs complete. Both scenarios are already built into the dev replay provider. Evidence: `/var/folders/yx/3lbxv4sn1wgf4n9gf5mm9_340000gn/T/polaris-smoke-NGpXNk`.
