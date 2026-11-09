# Polaris fork runbook

Run the fork server with a separate home and port:

```sh
export T3CODE_HOME="$HOME/.t3-polaris"
export T3CODE_PORT=3773
export T3CODE_TELEMETRY_ENABLED=false
export T3CODE_DISABLE_AUTO_UPDATE=true
node apps/server/src/bin.ts serve --base-dir "$T3CODE_HOME" --port "$T3CODE_PORT" --host 127.0.0.1
```

Mint the bridge credential against that home and set it in the bridge environment:

```sh
export T3_TOKEN="$(node apps/server/src/bin.ts auth session issue --base-dir "$T3CODE_HOME" --token-only)"
export T3_ORIGIN="http://127.0.0.1:$T3CODE_PORT"
export POLARIS_SERVER="http://127.0.0.1:43117"
vp run --filter @t3tools/polaris-bridge start
```

The bridge also reads `~/.polaris/t3-bridge.json`, or the path in
`POLARIS_T3_BRIDGE_CONFIG`. Environment variables override the file. Set
`POLARIS_T3_BRIDGE_TOKEN` to require a bearer token on its loopback API.

Merge upstream on the fork branch:

```sh
git config rerere.enabled true
git fetch upstream
git checkout main
git merge --ff-only upstream/main
git checkout polaris
git merge main
vp i
```

Verify after a merge:

```sh
node apps/polaris-bridge/scripts/check-seams.ts
vp run --filter @t3tools/polaris-bridge typecheck
vp run --filter @t3tools/polaris-bridge test
vp run --filter t3 typecheck
vp test run apps/server/src/polaris
node apps/polaris-bridge/scripts/smoke.ts
```
