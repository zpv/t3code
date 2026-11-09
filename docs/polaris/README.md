# Polaris fork of T3 Code

This fork makes T3 Code the client and conversation runtime for
[Polaris](https://github.com/zpv/polaris). Upstream is `pingdotgg/t3code`.

## Who owns what

| Concern                                                                                                         | Owner                                                                   |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Agent conversations (Claude, Codex): turns, history, approvals, questions, terminals, diffs                     | T3 Code server (this fork), using the upstream native drivers unchanged |
| Run registry and run API (`/v0/runs/*`), event log, Discord bridges, CLI, MCP tools, Brief, phone notifications | `polarisd`                                                              |
| Ports, tunnels, simulator leases and streams, app builds, reviews, pastes, artifacts                            | `polarisd`                                                              |
| Shell runs (Metro, dev servers)                                                                                 | `polarisd`, tmux-backed as before                                       |

A Polaris run, a T3 thread and a Discord thread map one-to-one:

```txt
Discord thread  <->  Polaris run (backend: "t3")  <->  T3 thread
```

`polarisd` keeps its run API as the stable contract. A run has a backend: `tmux`
(the original, still used for shell runs and un-migrated agent runs) or `t3`. For a
`t3` run, `polarisd` forwards create, input, stop and snapshot to the bridge, and the
bridge feeds conversation events back into the Polaris event log. Everything that
consumes the run API (Discord, CLI, MCP, Brief, Hub, phone notifications) keeps
working without knowing which backend a run has.

```txt
        web / desktop / mobile clients
                    |  (T3 RPC, pairing, Tailscale)
            T3 Code server (fork) ---- /api/polaris/* (proxy + import)
                    ^   |
    WS RPC (bearer) |   | loopback HTTP
                    |   v
             polaris-bridge  <----- loopback HTTP ----->  polarisd  <-- Discord, CLI, MCP, Brief
              (apps/polaris-bridge)      CONTRACT.md       (zpv/polaris)
```

Both servers run on the Polaris host. Clients reach the T3 server over Tailscale;
`polarisd` stays loopback-only.

The wire contract between the bridge and `polarisd` is [CONTRACT.md](./CONTRACT.md).
The same file is committed in `zpv/polaris` at `docs/T3_CONTRACT.md`; change both together.

## Fork components

| Component                                                                          | Location                                                         | Upstream files edited                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| Bridge: headless WS RPC client of the T3 server, loopback HTTP API for `polarisd`  | `apps/polaris-bridge/` (new package)                             | none                                                                  |
| Session import with visible history, and authenticated reverse proxy to `polarisd` | `apps/server/src/polaris/` (new files)                           | `apps/server/src/server.ts` (one layer entry per route)               |
| Polaris panels in the web client (ports, tunnels, simulators, Brief)               | `apps/web/src/polaris/`, `apps/web/src/routes/_chat.polaris.tsx` | `apps/web/src/routes/__root.tsx` (one host line), optional nav button |
| Fork tooling                                                                       | `scripts/polaris/`                                               | none                                                                  |
| Docs                                                                               | `docs/polaris/`                                                  | none                                                                  |

## Staying mergeable

Upstream lands about 150 commits a day. The rules that keep merges cheap:

1. **`main` mirrors `upstream/main`.** Never commit to it. All fork work is on `polaris`.
2. **Merge, do not rebase.** `git fetch upstream && git checkout main && git merge --ff-only upstream/main && git checkout polaris && git merge main`. Enable `git config rerere.enabled true`.
3. **New code goes in new files.** Fork-owned paths are listed above and never conflict.
4. **Every edit to an upstream file is a seam.** Keep it to one or two lines, mark it with a `polaris-fork` comment, and list it in [SEAMS.md](./SEAMS.md). `node scripts/polaris/check-seams.ts` fails when a seam listed there is missing, so a merge that silently drops one is caught.
5. **Never edit the hot files:** `packages/contracts/src/rpc.ts`, `apps/server/src/ws.ts`, `packages/contracts/src/orchestrationV2.ts`, `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/auth/RpcAuthorization.ts`, `apps/server/src/observability/RpcInstrumentation.ts`, `packages/contracts/src/environment.ts`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/rightPanelStore.ts`, `apps/web/src/components/settings/settingsSearch.ts`. New server capabilities are HTTP routes under `/api/polaris/*`, not RPC methods.
6. **Generated files are regenerated, not merged:** `pnpm-lock.yaml` (`vp i`) and `apps/web/src/routeTree.gen.ts`.
7. **The bridge compiles against `@t3tools/contracts`.** After a merge, `vp run --filter @t3tools/polaris-bridge typecheck` and its tests show any contract drift, confined to fork-owned code.
8. **Upstream CI workflows stay as files** (deleting them conflicts) and are disabled in the fork's repository settings.

## Running beside an installed T3 Code

The fork must never touch `~/.t3`. Run it with its own home and port and with upstream
telemetry and auto-update off. See [RUNBOOK.md](./RUNBOOK.md).

## Migration from tmux-backed runs

`polaris t3 migrate` imports existing Claude and Codex runs as T3 threads and flips
their backend. Selection: every agent run with conversation activity in the last 14
days, plus, for any project that would have fewer than 5, its 5 most recent. The run ID
and Discord bridge are unchanged, the T3 thread gets the visible history, and the next
message resumes the same native session. A run with a live tmux TUI is migrated only
when it is idle and only on request, because two processes writing one native session
would split the conversation. `polaris t3 rollback <run-id>` flips a run back.
