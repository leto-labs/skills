# Worker prompts

A worker is the agent in the thread that you create. The first prompt is its specification. Write it from the substantive task, not from the complete user message.

## Contents

- [Controller mechanics and worker task](#controller-mechanics-and-worker-task)
- [Prompt structure](#prompt-structure)
- [Example](#example)
- [Check before dispatch](#check-before-dispatch)
- [Names and titles](#names-and-titles)

## Controller mechanics and worker task

When the worker gets its first turn, the controller has already done the thread and worktree setup. If the prompt repeats the setup instructions, the worker spends time to decide whether it must create a thread or a worktree that already exists.

Sort each part of the user request into one of three kinds:

| Kind | Examples | Destination |
| --- | --- | --- |
| Controller mechanics | Create a thread or worktree. Select the branch, base, provider, model, effort, speed or interaction mode. Copy `.env`. Link data. Archive or remove a worktree. | Do these with `t3ctl`. Do not put them in the worker prompt. |
| Worker task | Analyze, implement, review, integrate, run tests. Requirements, rationale, acceptance criteria, technical questions. | Put these in the worker prompt with full detail. |
| Worker context | Source worktree path, commit IDs, owned and forbidden files, external-resource limits, validation that is already done. | Put these in the prompt as short context or in a `Controller addendum` section. |

Keep every requirement, rationale, example, caveat and acceptance criterion. Remove only the orchestration wrapper. Do not replace the task with a short summary.

## Prompt structure

1. Start with the bootstrap statement:

   ```text
   You are already in the T3-managed <worktree-name> worktree on branch <branch>, created from <base-branch>. Do not create or manage another thread or worktree.
   ```

   For a shared-worktree thread, use:

   ```text
   You are in the existing <worktree-name> worktree, which other threads also use. Do not create a worktree. Before you edit, run git status and do not change files that other threads own. Name the files that you intend to change and wait for confirmation.
   ```

2. Give the worker task.
3. Give the worker context.
4. Give the handoff: the tests to run, the commit or report to produce, and the condition for completion.

Do not name the model, the provider or the speed in the prompt. The persisted model selection controls them. If the worker must stop for approval before it edits, say so in the prompt. Do not use Plan mode for this unless the user asks for it.

## Example

User request:

```text
Create a new worktree with Opus at high effort, then inspect the simulator and propose a refactor.
```

Controller actions: `t3ctl create-thread --worktree-name sim-refactor --effort high ...`

Worker prompt:

```text
You are already in the T3-managed sim-refactor worktree on branch sim-refactor, created from main. Do not create or manage another thread or worktree. Inspect the simulator and propose a refactor.
```

## Check before dispatch

Compare the worker prompt with the user request. Make sure that:

1. Every substantive requirement is in the prompt.
2. You did every controller action, or you reported it as a blocker.
3. No instruction tells the worker to do the bootstrap again.
4. Your report to the user names the controller instructions that you removed and confirms that the substantive content is in the prompt.

## Names and titles

- A worktree name is lower-kebab text that matches `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`. Examples: `sim-refactor`, `mempool-backfill`, `test-t3-sim-reader`.
- The thread title is `<worktree-name>: <description>`. Example: `sim-refactor: Review simulator module boundaries`.
- For a namespaced branch such as `test/t3-sim-reader`, the default worktree name is `test-t3-sim-reader`.
