# Move a thread to another harness

This procedure continues the work of one T3 thread in a new thread with a different harness, for example from Codex to Claude. The new thread uses the same worktree and branch. The old thread stays unchanged until the user confirms that you can archive it.

## Contents

- [Why a new thread](#why-a-new-thread)
- [Steps](#steps)
- [The handoff bundle](#the-handoff-bundle)
- [Subagent task](#subagent-task)
- [Brief template](#brief-template)
- [Checks before dispatch](#checks-before-dispatch)

## Why a new thread

T3 binds a provider session to a thread. A thread cannot change from Codex to Claude and keep its provider context. The new harness gets no memory of the old conversation. It gets only the prompt that you give it. Because of this, the quality of the continuation depends on the brief.

## Steps

1. Find the source thread:

   ```bash
   t3ctl thread ~/.t3/worktrees/example-project/feature-example
   ```

   If `t3ctl` shows a warning that more than one thread uses the path, show the candidates to the user and confirm the correct thread.

2. Check the state. If it is `running`, `working`, `monitoring` or `attention`, run `t3ctl wait <thread-id> --until-quiet` or ask the user. Two agents in one worktree can make conflicting changes.

3. Write the bundle:

   ```bash
   t3ctl handoff <thread-id>
   ```

   The output gives `outDir`, the file list, the message count and the transcript size.

4. Start a subagent with the [subagent task](#subagent-task). In Claude Code, use the Agent tool. In Codex, use a native subagent. If no subagent is available, read `transcript-recent.md` and `git.md` yourself, and search `transcript-full.md` with `grep` for details.

5. Read `brief.md`. Check each claim against the bundle or the repository. Remove guesses. Add missing user decisions.

6. Dry-run the new thread. The default harness is the caller's harness:

   ```bash
   t3ctl continue-thread <thread-id> --prompt-file <outDir>/brief.md --dry-run
   ```

   Check `modelSelection`, `branch`, `worktreePath` and `projectId`. To select a harness other than your own, add `--harness claude` or `--model-instance <id>`.

7. Run the command without `--dry-run`. Run `t3ctl thread <new-thread-id>` and check that the thread started.

8. Report to the user: the new thread ID, the model, the brief location and the old thread ID. Recommend that the user sends no more turns to the old thread. Run `t3ctl archive <old-thread-id>` only when the user confirms.

## The handoff bundle

`t3ctl handoff` writes these files to `~/.local/state/t3ctl/handoffs/<thread-id>-<time>/` (or `--out <dir>`):

| File | Content |
| --- | --- |
| `thread.json` | Thread metadata: title, project, branch, worktree, model, modes, state |
| `transcript-recent.md` | The last user turns (default 8, `--turns N`), with errors. Long messages are shortened to 6000 characters. |
| `transcript-full.md` | All messages and proposed plans, not shortened |
| `git.md` | Branch status, commits not in the base branch, diff statistics. Each section is limited to 60 lines. |
| `processes.md` | Processes with a working directory in the worktree, for example long studies or services. Token-like values are redacted. |

The bundle is outside the repository, so it does not change `git status`. It contains the conversation text. Do not commit it or copy it to a shared location.

## Subagent task

Give the subagent this task. Replace the placeholders.

```text
Read the T3 handoff bundle in <outDir>. Start with thread.json, transcript-recent.md, git.md and processes.md. Use transcript-full.md to find the objective, user decisions and constraints from earlier turns. Read the repository instructions (AGENTS.md or CLAUDE.md) and any plan or change document that the transcript names, in <worktree>.

Write <outDir>/brief.md with the template below. The brief is the complete first prompt for a new agent that continues this work in the same worktree. The new agent has no access to the old conversation except through the bundle.

Rules:
- State only facts that the bundle or the repository supports. Mark each inference as an inference.
- Keep every user decision, preference, constraint and acceptance criterion. Quote the user when the exact wording matters.
- Give file paths, commands, commit IDs and process IDs exactly.
- Do not change files in the worktree. Do not start or stop processes.
- Keep the brief under 1500 words. Put details in the "Reference" section as pointers to bundle files.

Report the path of brief.md and any facts that you could not confirm.
```

## Brief template

```markdown
You are continuing the work of T3 thread <old-thread-id> ("<title>"), which ran on <old-model>. You are in the existing T3-managed <worktree-name> worktree at <worktree-path>, on branch <branch>. Do not create or manage another thread or worktree.

## Objective
<The goal of the work, in the user's terms. Include the owning plan or change document.>

## User decisions and constraints
- <Decisions, preferences, scope limits and acceptance criteria from the user.>

## Current state
- Done: <completed work, with commits and evidence>
- In progress: <work that started but is not complete>
- Running processes: <each process from processes.md, what it does, how to check it. Do not restart or stop it unless the user asks.>
- Uncommitted changes: <from git.md>

## Last exchange
<The last user request and what the previous agent did or said in answer. State whether the request is complete.>

## Next steps
1. <First concrete step>
2. <...>

## Open questions and risks
- <Unresolved questions. Known problems.>

## Reference
- Handoff bundle: <outDir> (transcript-full.md has the full conversation)
- Key files: <paths>
- Validation commands: <commands>
```

## Checks before dispatch

1. The first paragraph names the old thread, the worktree and the branch, and tells the agent not to create a thread or worktree.
2. The objective and the last user request agree with the transcript.
3. Every running process in `processes.md` is in the brief, with an instruction not to restart it.
4. The brief does not tell the agent which model to use. The model selection controls it.
5. The brief does not include tokens, `.env` values or other secrets.
