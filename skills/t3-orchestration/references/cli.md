# t3ctl command reference

`t3ctl` is `<skill-dir>/scripts/t3ctl`. It runs `scripts/t3-rpc.ts` with Node 22.18 or later, or with `tsx` if Node is older. Run `t3ctl help` for the short usage text.

Maintainers can run offline CLI regression tests with `node --test <skill-dir>/scripts/t3-rpc.test.mjs` (Node 22.18+). These tests mock authentication and transport; they do not connect to T3 or mutate worktrees.

## Contents

- [Commands](#commands)
- [Flags for create commands](#flags-for-create-commands)
- [Model flags](#model-flags)
- [Authentication](#authentication)
- [Environment variables](#environment-variables)
- [Output and exit codes](#output-and-exit-codes)

## Commands

### Inspect

| Command | Result |
| --- | --- |
| `doctor` | JSON report: authentication mode, server version, ready provider instances, snapshot counts and the detected harness. Exit code 1 if a check fails. |
| `harness [model flags]` | The detected harness and the model selection that a new thread gets. This command does not connect to the server. |
| `providers [--instance <id>] [--refresh] [--all] [--json]` | Provider readiness, reported usage windows, reset times and reset-credit counts. Enabled instances by default. `--refresh` probes through T3 before reading the snapshot. |
| `models [--instance <id>] [--json]` | Provider instances with their models and option values. `*` marks the provider default value. |
| `projects [flags]` | Projects, newest activity first, with counts of active, running, attention and archived threads. |
| `threads [flags]` | Threads, newest update first. See [thread filters](#thread-filters). |
| `thread <thread-id\|path>` | One thread as JSON, with the derived `state`. |
| `history <thread-id\|path> [flags]` | The conversation as Markdown or JSON. See [history](#history). |
| `search <query> [--limit N] [--json]` | Full-text search of user and assistant messages in all threads. Limit 1 to 50, default 20. |
| `wait <thread-id> [--timeout 30m] [--interval 15s] [--until-quiet]` | Waits while the thread is `running` or `working`. With `--until-quiet`, it also waits while the thread is `monitoring`. The output gives `reason` and `state`. Exit code 3 on timeout. |
| `snapshot` | Merged active and archived shell snapshot as JSON. |

A path argument resolves to the thread whose `worktreePath` is that path. For the project root, it resolves to the project threads that have no worktree. If more than one thread matches, `t3ctl` selects the newest unarchived thread and lists the others on stderr. Add `--all` to include archived threads.

### Thread states

`t3ctl` derives one state for each thread:

| State | Meaning |
| --- | --- |
| `new` | The thread has no turn yet. |
| `running` | The latest turn runs, or the session starts. |
| `working` | The turn ended, but background agents (subagents, workflow runs, Codex child agents) still run. The T3 sidebar shows "Working". |
| `monitoring` | The turn ended and only watch loops (Monitor tasks, background shells) still run. The T3 sidebar shows "Monitoring". A watch loop can run for hours and can start new agent work. |
| `attention` | The thread waits for an approval or a user-input answer. |
| `error` | The latest turn or the session failed, for example at a provider usage limit. Read the last turn before you send more work. A failed session has priority over background work. |
| `idle` | The latest turn ended and T3 reports no background work. Processes that the thread started outside the provider session can still run. |
| `archived` | The thread is archived. |

### Thread filters

| Flag | Filter |
| --- | --- |
| `--project <id\|title\|path>` | Project ID, part of the title or root path, or an absolute root path. Alias: `--project-id`. |
| `--state <list>` | Comma list of states, for example `running,attention`. |
| `--harness <list>` | `codex`, `claude` |
| `--instance <list>` | Provider instance IDs, for example `codex_team_b` |
| `--model <list>` | Model slugs |
| `--branch <text>` | Part of the branch name |
| `--worktree <path>` | Exact worktree path |
| `--search <text>` | Part of the title. For message text, use `search`. |
| `--since <duration>` | Updated in the last `30m`, `2h`, `7d` and so on |
| `--all` | Include archived threads |
| `--archived` | Only archived threads |
| `--sort <key>` | `updated` (default), `created`, `message` (last user message) or `title` |
| `--reverse` | Reverse the sort order |
| `--limit <N>` | Show at most N threads |

`projects` accepts `--search <text|path>`, `--active` (only projects with active threads), `--limit` and `--json`.

### History

| Flag | Meaning |
| --- | --- |
| `--turns <N>` | Read the last N user turns. Default 10. |
| `--before <cursor>` | Read the page of turns before the cursor. The previous page prints the cursor on stderr. |
| `--all` | Read the full thread in one request. |
| `--activities` | Add error activities. `--activities=all` adds all tool activities. |
| `--user-only` | Show only user messages. |
| `--max-chars <N>` | Shorten each message to N characters. |
| `--json` | Print the raw thread detail and page data. |
| `--out <file>` | Write to a file instead of stdout. |

Read a small window first. For a full review, write `--all --out <file>` and give the file to a subagent.

### Create threads

| Command | Result |
| --- | --- |
| `create-thread` | Creates a T3-managed worktree and branch, then starts a thread in it. |
| `create-shared-thread` | Starts a thread in an existing worktree (`--worktree-path <path>`) or in the project root (no `--worktree-path`). T3 does not create a worktree. |
| `continue-thread <thread-id\|path>` | Starts a thread in the same project, branch and checkout as an existing thread. It uses the caller's harness by default. It stops if the source thread is `running`, `working` or `monitoring`, unless you give `--allow-running`. The default description is the source description with ` (continued)`. It does not change the source thread. |
| `handoff <thread-id\|path> [--out <dir>] [--turns N] [--base-branch <branch>]` | Writes a handoff bundle. See [migration.md](migration.md#the-handoff-bundle). |

All create commands need `--description` (optional for `continue-thread`) and `--prompt <text>` or `--prompt-file <file>`. Use `--prompt-file` for long prompts. `create-thread` needs `--worktree-name` or `--branch`. If you give only `--branch`, `t3ctl` replaces `/` with `-` to make the worktree name. `create-shared-thread` needs `--worktree-name`.

### Operate threads

| Command | Result |
| --- | --- |
| `send <thread-id> <message> [--interaction-mode <mode>] [model flags] [--dry-run]` | Starts a turn. Without model flags, the thread keeps its persisted model selection. Without `--interaction-mode`, the thread keeps its mode. If the thread runs, Claude adds the message to the running turn and Codex queues it. |
| `interrupt <thread-id> [turn-id]` | Interrupts the active turn. |
| `stop <thread-id>` | Stops the provider session. |
| `set-mode <thread-id> [--interaction-mode default\|plan] [--runtime-mode <mode>]` | Changes the modes. |
| `approve <thread-id> <request-id> <accept\|acceptForSession\|decline\|cancel>` | Responds to an approval request. |
| `answer <thread-id> <request-id> <answers-json-or-file>` | Responds to a user-input request. |
| `archive`, `unarchive`, `delete <thread-id>` | Changes the thread state. `delete` is permanent. Use it only on explicit user request. |
| `remove-worktree --project-cwd <path> --worktree-path <path> [--force] [--dry-run]` | Removes a T3-managed worktree. Use it only on explicit user request. |

### Low level

| Command | Result |
| --- | --- |
| `rpc <method> [payload-json-or-file]` | Sends one WebSocket RPC request, for example `rpc server.getConfig '{}'`. |
| `dispatch <command-json-file>` | Dispatches one orchestration command. |
| `uuid` | Prints a random UUID. |

## Flags for create commands

| Flag | Default | Notes |
| --- | --- | --- |
| `--project-id <id>` | The project whose `workspaceRoot` is the main checkout of the current git repository | Works from the main checkout and from any linked worktree. |
| `--project-cwd <path>` | The project `workspaceRoot` | T3 creates the new worktree from this checkout. |
| `--base-branch <branch>` | `main` | `create-thread` only. |
| `--start-from-origin` | off | `create-thread` only. T3 creates the branch from `origin/<base-branch>`. |
| `--worktree-path <path\|null>` | project root | `create-shared-thread` only. |
| `--interaction-mode <default\|plan>` | `default` | The T3 UI shows `default` as "Build". Use `plan` only when the user asks for Plan mode. |
| `--runtime-mode <mode>` | `full-access` | |
| `--run-setup-script <true\|false>` | `false` | Runs the project setup script after worktree creation. |
| `--dry-run` | off | Prints the command. Does not change T3 state. It still reads the server to resolve the project and validate the model. |
| `--no-validate` | off | Skips the live model check. Use it only when the server catalog is wrong. |

## Model flags

Model flags apply to `create-thread`, `create-shared-thread`, `continue-thread`, `send` and `harness`. Read [models.md](models.md) for the policy and the provider option IDs.

| Flag | Meaning |
| --- | --- |
| `--harness <codex\|claude>` | Overrides harness detection. |
| `--model-instance <id>` | Selects a provider instance, for example `codex_team_a`. The driver of the instance sets the defaults. |
| `--model <slug>` | Selects a model. Aliases that T3 knows are accepted. |
| `--effort <level>` | Codex `reasoningEffort` or Claude `effort`. Alias: `--reasoning-effort`. |
| `--fast <true\|false>` | Codex service tier `priority` or `default`, or Claude `fastMode`. Alias: `--fast-mode`. |
| `--service-tier <default\|priority>` | Codex only. Overrides `--fast`. `fast` is read as `priority`. |
| `--context-window <200k\|1m>` | Claude only. |
| `--option <id=value>` | Sets any other provider option. Repeat the flag for more options. `true` and `false` become booleans. |

## Authentication

`t3ctl` selects the first method that is available:

1. `T3_BEARER_TOKEN`, if it is set.
2. The Electron session cookie in `T3_COOKIE_DB` (default `~/.config/t3code/Cookies`). T3 v0.0.42 names it `t3_session_<port>` or `t3_session_<port>_<hash>`. `t3ctl` reads it with the built-in `node:sqlite` module, or with the `sqlite3` CLI on older Node versions. If the server rejects the cookie (401), `t3ctl` changes to method 3 once.
3. An automatic token. `t3ctl` runs `t3 auth session issue --ttl 15m --label t3ctl --json`, uses the token for the command and then runs `t3 auth session revoke`. It finds `t3` in `T3_CLI`, then on `PATH`, then in the newest `~/.t3/runtime/versions/*/t3`.

`doctor` shows the method in `checks.authentication.mode` (`bearer-env`, `cookie` or `bearer-auto`).

If all methods fail, `doctor` shows one reason for each method. Common causes:

- The T3 server does not run. Check `t3 --version` and the T3 service.
- The `t3` CLI uses a different data directory. Set `T3CODE_HOME` to the server data directory.
- The server is not on `127.0.0.1:3773`. Set `T3_BASE_URL`.

To examine sessions, run `t3 auth session list`. It does not show token values. If a revoke fails, `t3ctl` shows the session ID. The token expires after its TTL.

Repository `.env` files, Bitwarden secrets and model-provider keys do not give access to T3. T3 session authentication is independent of them.

## Environment variables

| Variable | Default | Use |
| --- | --- | --- |
| `T3_BASE_URL` | `http://127.0.0.1:3773` | Server URL |
| `T3_BEARER_TOKEN` | not set | Use this token. No automatic token is issued. |
| `T3_COOKIE_DB` | `~/.config/t3code/Cookies` | Electron cookie database |
| `T3_COOKIE_NAME` | `t3_session_<port>` or `t3_session_<port>_<hash>` | Exact cookie name |
| `T3_AUTO_TOKEN` | `1` | Set `0` to disable automatic tokens |
| `T3_AUTO_TOKEN_TTL` | `15m` | TTL of automatic tokens |
| `T3_CLI` | not set | Path to the `t3` executable |
| `T3_HARNESS` | not set | `codex` or `claude`. Overrides harness detection. |
| `T3_MODEL_INSTANCE` | not set | Default provider instance for new threads |

## Output and exit codes

Commands print JSON to stdout, except `threads`, `projects`, `models` and `search`, which print tab-separated text, and `history`, which prints Markdown. Give `--json` for JSON. Warnings go to stderr with the prefix `warning:`.

| Exit code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Server, authentication or validation error |
| 2 | Usage error: missing or incorrect arguments |
| 3 | `wait` timed out |
