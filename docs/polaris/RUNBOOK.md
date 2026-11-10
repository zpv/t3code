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

## Accounts and remote clients

Create a Claude token with `claude setup-token` and store it in a private file such as
`~/.polaris/accounts/claude-second.token` (`chmod 600`); the default account can use
its existing login. For another Codex account, run
`CODEX_HOME="$HOME/.polaris/accounts/codex-second" codex login`. Keep that directory's
`auth.json` a regular file. The bridge shares the default provider's continuation home
and uses the second Codex home for its credentials.

Configure `~/.polaris/t3-bridge.json` (or `POLARIS_T3_BRIDGE_CONFIG`) with:

```json
{
  "publicOrigin": "https://t3.example.tailnet.ts.net",
  "agentBriefFile": "~/.polaris/t3-agent-brief.md",
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

Omit `accounts` to use the built-in Claude and Codex instances. The bridge reloads the
file when it changes. `T3_PUBLIC_ORIGIN` overrides `publicOrigin`; otherwise links use
the server's advertised tailnet or LAN endpoints before falling back to `T3_ORIGIN`.
The old `instances` key must be replaced by `accounts`.

For another machine to connect directly, run the T3 server with a reachable host, for
example `--host 0.0.0.0`, on a trusted network. Keep polarisd and the bridge on loopback.
Create a pairing link with `node apps/server/src/bin.ts pair --base-dir "$T3CODE_HOME"`
and open it in the client on the other machine. Use the server's advertised tailnet
address or configure `publicOrigin` when the link should use a public HTTPS endpoint.
