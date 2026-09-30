---
name: t3-orchestration
description: Control a running T3 Code server from an agent through the bundled `t3ctl` CLI. Use this skill to list and filter T3 projects and threads, read thread history, search messages, create T3-visible threads and T3-managed git worktrees, spawn Codex or Claude child threads, send follow-up turns, wait for threads, answer approvals and user-input requests, archive threads and remove worktrees. Also use it to move or continue a thread in another harness (for example Codex to Claude) from a thread ID or a worktree path, and to diagnose T3 authentication, headless (no Electron) access and model selection. Use it whenever a task mentions T3 threads, T3 worktrees, a `~/.t3/worktrees/...` path, parallel agents in T3, "spawn a thread" or "migrate this thread", even if the user does not name the skill. Do not use it for Create T3 App or other unrelated "T3" web stacks.
---

# T3 Orchestration

This skill controls a running T3 Code server through its authenticated API. T3 has no CLI for threads, history, turns, worktree bootstrap or approvals. The bundled `t3ctl` command supplies these operations. Make all T3-visible changes with `t3ctl` so that the T3 UI and the server stay consistent.

In this document, `t3ctl` means `<skill-dir>/scripts/t3ctl`. `<skill-dir>` is the directory that contains this file, for example `~/.agents/skills/t3-orchestration`.

## Rules

- Use `t3ctl` for all thread, turn, worktree and approval operations. Do not use tmux, manual `git worktree` commands or direct SQLite access as a substitute.
- Create threads and worktrees only when the user or the repository instructions permit it. A feature-worktree agent does not create threads unless the user explicitly permits it.
- Archive a completed thread. Remove a worktree or delete a thread only when the user explicitly asks for it.
- Do not print T3 tokens, cookies or tickets. Treat raw server errors, thread history and handoff exports as sensitive; inspect and redact them before sharing.
- Apply the repository `AGENTS.md` or `CLAUDE.md` rules for data, credentials and worktree ownership. These rules have priority over this skill.

## Start

Run `t3ctl doctor` before the first operation in a session. It checks authentication, the server version, the ready providers and the detected harness. If it reports an error, read [references/cli.md](references/cli.md#authentication). `t3ctl` does not need the Electron app. It issues a 15-minute T3 session token with the `t3` CLI and revokes the token when the command ends.

## Find projects and threads

| Need | Command |
| --- | --- |
| Provider usage and reset times | `t3ctl providers --refresh` |
| Provider usage as JSON | `t3ctl providers --instance codex --refresh --json` |
| Projects with activity counts | `t3ctl projects --active` |
| Threads of one project, newest first | `t3ctl threads --project example-project` |
| Threads by state or harness | `t3ctl threads --state running,working,attention,error --harness codex` |
| Recently changed threads | `t3ctl threads --since 2h` |
| The thread of a worktree | `t3ctl thread ~/.t3/worktrees/<project>/<name>` |
| Recent conversation | `t3ctl history <thread-id-or-path> --turns 5` |
| Older conversation | `t3ctl history <thread-id> --before <cursor>` (the cursor is printed on stderr) |
| Text in any thread | `t3ctl search "<words>"` |

Thread states are `new`, `running` (a turn runs), `working` (the turn ended but subagents or workflows still run), `monitoring` (only watch loops such as Monitor tasks or background shells still run), `attention` (it waits for an approval or an answer), `error` (the last turn or the session failed), `idle` and `archived`. `working` and `monitoring` match the T3 sidebar pills. All listing commands accept `--json`. Read [references/cli.md](references/cli.md) for every filter.

History can be large. Read a few recent turns first. To examine a full thread, write it to a file with `--out` and give the file to a subagent.

## Model policy

A new thread uses the same harness as the agent that creates it. A Codex agent creates Codex threads. A Claude agent creates Claude threads. `t3ctl` detects the harness from the environment.

| Harness | Instance | Model | Options |
| --- | --- | --- | --- |
| Claude | `claudeAgent` | `claude-opus-5-5` | effort `medium`, fast mode on, context window `1m` |
| Codex | `codex` | `gpt-5.6-terra` | reasoning effort `medium`, service tier `priority` (fast) |

New threads start in the `default` interaction mode. The T3 UI shows this mode as "Build". Do not select Plan mode unless the user asks for it.

These are bundled presets, not universal provider defaults. Check `t3ctl models` before creating a thread; select an available model and follow the user's or project's model and cost policy. Use flags, not prompt text: `--harness`, `--model-instance`, `--model`, `--effort`, `--fast`, `--context-window`, `--service-tier` and `--option id=value`. `t3ctl` normally validates selections against the live catalog; do not bypass validation for live operations. Read [references/models.md](references/models.md) for model and account selection.

## Procedure: create a worktree thread

1. Separate the controller mechanics from the worker task. Read [references/worker-prompts.md](references/worker-prompts.md) before you write the prompt.
2. Select a lower-kebab `worktree-name` (for example `sim-refactor`) and a short description. The thread title becomes `<worktree-name>: <description>`.
3. Run the command with `--dry-run`. Check the model selection, the project and the base branch in the output.

   ```bash
   t3ctl create-thread --worktree-name sim-refactor \
     --description "Review simulator module boundaries" \
     --prompt-file /tmp/sim-refactor-prompt.md --dry-run
   ```

4. Run the same command without `--dry-run`. Record the `threadId`.
5. Run `t3ctl thread <thread-id>` until `worktreePath` is set. Check `modelSelection`.
6. Apply the repository rules for `.env` files and data copies to the new worktree.

`t3ctl` finds the project from the current git repository. Use `--project-id` only for a different project. Use `--base-branch` when the base is not `main`. For a thread in an existing worktree or in the project root, use `create-shared-thread` and read [references/workflows.md](references/workflows.md#shared-worktree-threads).

## Account switches and usage limits

Run `t3ctl providers --refresh` before selecting an account. Use `--json` for automation. A `ready` provider can have exhausted credits. Check each usage window and its timestamp. Missing limits mean unknown availability. Reset-credit counts are separate from remaining usage. This command does not redeem credits or change accounts.

T3 0.0.42 can fail an account switch with `already has an active writer`. Read [the account-switch recovery notes](references/models.md#account-switch-failure-in-t3-0042) before recovery. Preserve the native conversation and export a handoff before any session change.

## Procedure: move a thread to another harness

Use this procedure when the user asks to migrate, move or continue a thread with a different harness, for example from Codex to Claude. The user can identify the thread by ID or by worktree path.

1. Run `t3ctl thread <thread-id-or-path>`. Confirm the thread, its branch and its state with the user if more than one thread uses the path.
2. If the state is `running`, `working` or `monitoring`, run `t3ctl wait <thread-id> --until-quiet` or ask the user. Do not interrupt it without permission. Background agents and watch loops can still change the worktree.
3. Run `t3ctl handoff <thread-id-or-path>`. It writes the metadata, transcripts, git state and running processes to a bundle directory.
4. Give the bundle to a subagent. The subagent writes `brief.md` from the template in [references/migration.md](references/migration.md). This keeps the long transcript out of your context.
5. Read the brief. Correct it against the bundle and the repository.
6. Run `t3ctl continue-thread <thread-id> --prompt-file <bundle>/brief.md --dry-run`, then run it without `--dry-run`.
7. Tell the user the new thread ID. Archive the old thread only when the user confirms.

Read [references/migration.md](references/migration.md) before step 3.

## Procedure: operate a thread

- Send a follow-up turn: `t3ctl send <thread-id> "<message>"`. The thread keeps its model and modes unless you give flags. If the thread is running, a Claude thread adds the message to the running turn and a Codex thread queues it. To send a separate turn, run `t3ctl wait <thread-id>` first.
- Wait for a thread: `t3ctl wait <thread-id> --timeout 30m`. It waits while the thread is `running` or `working` and stops at any other state, including `monitoring`. Add `--until-quiet` to also wait for watch loops to end. Exit code 3 means timeout.
- Approve a request: `t3ctl approve <thread-id> <request-id> accept`.
- Answer a user-input request: `t3ctl answer <thread-id> <request-id> '<answers-json>'`.
- Stop or interrupt: `t3ctl interrupt <thread-id>` or `t3ctl stop <thread-id>`.

## Procedure: finish work

1. Check that the worktree has no uncommitted changes.
2. Merge the branch from the control worktree. Validate the result.
3. Run `t3ctl archive <thread-id>`.
4. Keep the worktree. Run `t3ctl remove-worktree` only when the user asks for it.

Read [references/workflows.md](references/workflows.md) before you control more than one child thread or before a roll-in.

## References

| File | Read it when |
| --- | --- |
| [references/cli.md](references/cli.md) | You need a command, a filter, a flag, an environment variable or authentication details |
| [references/models.md](references/models.md) | You change the provider, model or options, or a model validation error occurs |
| [references/worker-prompts.md](references/worker-prompts.md) | You write the first prompt for a new thread |
| [references/migration.md](references/migration.md) | You move or continue a thread in another harness |
| [references/workflows.md](references/workflows.md) | You coordinate several threads, share a worktree, or roll work in |
| [references/t3-internals.md](references/t3-internals.md) | `t3ctl` fails after a T3 upgrade, or you need a raw RPC method or endpoint |
