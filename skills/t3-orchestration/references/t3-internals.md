# T3 internals

Verified against the T3 Code `v0.0.42` source (`pingdotgg/t3code`). Read this file when `t3ctl` fails after a T3 upgrade, or when you need an RPC method that `t3ctl` does not wrap.

## Contents

- [Control surfaces](#control-surfaces)
- [Connection and authentication flow](#connection-and-authentication-flow)
- [RPC methods](#rpc-methods)
- [Orchestration commands](#orchestration-commands)
- [Thread bootstrap](#thread-bootstrap)
- [Provider catalog](#provider-catalog)
- [Verify after a T3 upgrade](#verify-after-a-t3-upgrade)

## Control surfaces

- The `t3` CLI manages the server, authentication, projects and T3 Connect. It has no thread, turn, worktree-bootstrap, approval or archive commands. `t3ctl` uses it only for `t3 auth session issue` and `revoke`.
- The T3 MCP server (`/mcp`) gives each provider session a small tool set (previews, devices, pull-request links). It has no thread creation tools.
- The WebSocket RPC API at `/ws` has all orchestration operations. `t3ctl` uses it.

## Connection and authentication flow

1. Get credentials: a bearer token (`Authorization: Bearer ...`) or the Electron session cookie `t3_session_<port>`.
2. `POST /api/auth/websocket-ticket` with those credentials. The response contains `ticket`.
3. Connect to `/ws?wsTicket=<ticket>`.
4. Send Effect RPC envelopes: `{"_tag":"Request","id":"1","tag":"<method>","payload":{...},"headers":[]}`.
5. Answer `{"_tag":"Ping"}` with `{"_tag":"Pong"}`. A unary result arrives as `{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":...}}`. A stream sends `Chunk` messages with `values`.

A token from `t3 auth session issue` has the scopes `orchestration:read`, `orchestration:operate`, `terminal:operate` and others. Its default device type is `bot`.

HTTP endpoints:

- `GET /api/auth/session`
- `POST /api/auth/websocket-ticket`
- `GET /api/orchestration/snapshot` (fallback for thread listing)
- `GET /api/orchestration/threads/:threadId?turnLimit=N&beforeCursor=C` (thread detail with `messages`, `activities`, `proposedPlans`, `checkpoints`. With `turnLimit`, the response has `page.beforeCursor` and `page.hasMore`. `turnLimit` counts user turns. Without it, the response is the full thread.)
- `POST /api/orchestration/dispatch`

## RPC methods

| Method | Use |
| --- | --- |
| `orchestration.subscribeShell` | Stream. The first value is `{kind:"snapshot", snapshot}` with active projects and threads. |
| `orchestration.getArchivedShellSnapshot` | Archived projects and threads. Merge it with the active snapshot. |
| `orchestration.dispatchCommand` | Dispatch one orchestration command. Use it for thread bootstrap, because it runs the T3 bootstrap wrapper. |
| `orchestration.subscribeThread` | Stream of one thread. Input `threadId`, optional `afterSequence` and `turnLimit`. |
| `orchestration.searchThreads` | Full-text search. Input `query` (2 to 200 characters), optional `limit` (1 to 50). Output `matches[]` with `threadId`, `projectId`, `source`, `snippet`, `messageCreatedAt`. |
| `orchestration.getTurnDiff`, `orchestration.getFullThreadDiff` | Diffs of the thread checkpoints. |
| `server.getConfig` | Server version, settings and `providers` (instances, models, option descriptors). |
| `server.refreshProviders` | Refresh provider status. |
| `vcs.refreshStatus`, `vcs.createWorktree`, `vcs.removeWorktree` | Git operations. |
| `terminal.open`, `terminal.write`, `terminal.attach`, `terminal.close` | Terminals. |

The complete list is `WS_METHODS` in `packages/contracts/src/rpc.ts`.

## Orchestration commands

Each command has `type`, `commandId` (UUID) and usually `threadId`. Commands that change a turn or a mode also need `createdAt` (ISO time).

- `thread.turn.start`
- `thread.turn.interrupt`
- `thread.session.stop`
- `thread.approval.respond`
- `thread.user-input.respond`
- `thread.checkpoint.revert`
- `thread.archive`, `thread.unarchive`, `thread.delete`
- `thread.runtime-mode.set`, `thread.interaction-mode.set`
- `thread.pull-request.link`, `thread.pull-request.unlink`

The schemas are in `packages/contracts/src/orchestration.ts`.

## Thread bootstrap

A new thread is one `thread.turn.start` command with a `bootstrap` object:

- `bootstrap.createThread`: `projectId`, `title`, `modelSelection`, `runtimeMode`, `interactionMode`, `branch`, `worktreePath`, `createdAt`.
- `bootstrap.prepareWorktree` (new worktree only): `projectCwd`, `baseBranch`, optional `branch`, optional `startFromOrigin`. With this object, set `createThread.branch` and `createThread.worktreePath` to `null`. T3 fills them in.
- `bootstrap.runSetupScript`: boolean.

For a thread in an existing worktree, omit `prepareWorktree`. Set `createThread.branch` and `createThread.worktreePath`. Use `worktreePath: null` for the project root.

In `thread.turn.start`, `modelSelection` is optional. If it is missing, the thread keeps its selection. `runtimeMode` and `interactionMode` have decoding defaults (`full-access` and `default`). Always send the current values, or a follow-up turn can change the thread mode.

Interaction modes are `default` and `plan` (`ProviderInteractionMode` in `packages/contracts/src/orchestration.ts`). The composer in the T3 UI shows `default` as "Build". The API does not accept `build`.

Thread shell entries have `backgroundLiveness`: `"working"`, `"monitoring"` or `null` (`apps/server/src/orchestration/ThreadBackgroundLiveness.ts`). The server keeps it in memory from task lifecycle events, after a turn ends. Any live agent task (subagent, workflow member, Codex child) gives `working`. Watch loops alone (task types `monitor`, `monitor_mcp`, `local_bash`, `shell`, in `MONITOR_TASK_TYPES` in `packages/contracts/src/providerRuntime.ts`) give `monitoring`. Tasks of type `plan` and `dream` are ignored. A server restart clears the state. The sidebar ranks a failed session above both values.

A `thread.turn.start` for a thread with a running turn does not start a second turn. The Claude adapter adds the message to the running turn (a steer). The Codex adapter queues the message.

## Provider catalog

`server.getConfig` returns `providers[]`. Each entry has `instanceId`, `driver`, `enabled`, `status`, `version` and `models[]`. Each model has `slug`, optional `aliases` and `capabilities.optionDescriptors[]`. A descriptor has `id`, `type` (`select` or `boolean`) and, for `select`, `options[]` with `id` and optional `isDefault`.

Several instances can use one driver. Example: `codex`, `codex_team_a` and `codex_team_b` all use the `codex` driver with different account home directories.

The server loads the model list from `apps/server/src/provider/model-manifest.json` and updates it at runtime from the upstream copy. The local cache is `~/.t3/userdata/model-manifest.json`. Because of this, a model can be available before it appears in a release.

## Verify after a T3 upgrade

1. Run `t3 --version` and `t3ctl doctor`.
2. Get the source of the new version: `opensrc path pingdotgg/t3code@v<version>`.
3. Compare `ThreadTurnStartCommand` and the bootstrap schemas in `packages/contracts/src/orchestration.ts` with `createThreadCommand` in `scripts/t3-rpc.ts`.
4. Compare `WS_METHODS` in `packages/contracts/src/rpc.ts` with the method names in this file.
5. Run `t3ctl models --json` and compare the option IDs with [models.md](models.md).
6. Run a `create-thread --dry-run` for each harness.
7. Update the version line at the start of this file.
