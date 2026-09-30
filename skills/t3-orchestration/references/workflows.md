# Orchestration workflows

## Contents

- [Main-worktree controller](#main-worktree-controller)
- [Feature-controller exception](#feature-controller-exception)
- [Shared worktree threads](#shared-worktree-threads)
- [Monitor children](#monitor-children)
- [Roll-in and cleanup](#roll-in-and-cleanup)

## Main-worktree controller

Use this pattern for normal parallel work in a repository.

- The main worktree of the repository is the control plane.
- Only the main-worktree controller creates or manages threads and worktrees, unless the user permits a different controller.
- Before you create children, read the repository instructions, `git status`, `t3ctl threads` and `git worktree list`.
- Give a child only independent work. Give each child exact file and API ownership and a list of forbidden areas.
- Write each child prompt as [worker-prompts.md](worker-prompts.md) describes.
- Create each worktree from the intended base branch. Then apply the repository rules for ignored data and credentials.
- Monitor the children, answer blockers, review their commits, merge from the control plane, validate and archive completed threads.

A feature-worktree agent that needs another worktree reports the need to the main controller. It does not create the worktree.

## Feature-controller exception

A long-running controller in a feature worktree is permitted only for a large implementation or refactor, and only after explicit user approval. The approval applies to the named objective only.

The feature controller:

- creates children from its own branch and HEAD,
- uses one lower-kebab prefix for all child names,
- limits the number of concurrent children,
- does not let children create children,
- keeps a registry of thread ID, branch, ownership, state, handoff commit, validation and integration commit.

Before it creates children, the controller writes a plan and does not edit files. The plan covers: objective and exclusions, controller branch, shared interfaces, child waves, ownership and merge order, integration gates, credentials and ignored data, external-resource ownership, monitoring, rollback and final roll-in. Present the plan for approval, unless the user already approved work under these terms.

## Shared worktree threads

`create-shared-thread` attaches a new thread to an existing worktree or to the project root. T3 does not create a worktree.

Use shared threads for read-heavy or coordinated work: research notes, primers, market analysis, simulation reports, or different sections of one documentation branch.

Do not use shared threads for independent code changes, broad refactors, or work where agents can edit the same files. Create separate worktrees for that work.

```bash
# Project root
t3ctl create-shared-thread --worktree-name main \
  --description "Review coordination docs" --prompt "$WORKER_PROMPT"

# Existing worktree
t3ctl create-shared-thread --worktree-name research-docs --branch research-docs \
  --worktree-path /path/to/research-docs \
  --description "Draft market analysis outline" --prompt "$WORKER_PROMPT"
```

Use the shared-worktree bootstrap statement from [worker-prompts.md](worker-prompts.md#prompt-structure).

## Monitor children

Read T3 state. Do not infer progress from files in a worktree.

- `t3ctl threads --json` gives the session status and latest turn status of each thread.
- `t3ctl thread <thread-id>` gives the pending approval and user-input flags and the plan progress.
- Before integration, check: bootstrap, branch, data copy, turn completion, `git status`, commits, tests and ignored artifacts.

While the children work, do useful controller work, for example integration review.

## Roll-in and cleanup

1. Check that the feature worktree has no uncommitted changes.
2. For compiled code, review new features, profiles, binaries, examples, benchmarks, validation commands and generated-artifact locations. Keep default commands narrow. A broad matrix, profile or benchmark needs a stated purpose.
3. Merge from the control worktree. Validate after each child and after each wave.
4. Report the merge commit and the validation results, including intentional non-default build variants.
5. Run `t3ctl archive <thread-id>`. The history stays visible.
6. Keep the worktree. Remove it only when the user explicitly asks:

   ```bash
   t3ctl remove-worktree --project-cwd "$MAIN_WORKTREE" --worktree-path "$FEATURE_WORKTREE" --dry-run
   t3ctl remove-worktree --project-cwd "$MAIN_WORKTREE" --worktree-path "$FEATURE_WORKTREE" --force
   ```

Archive is the default cleanup. Thread deletion and worktree removal are separate destructive actions. A roll-in does not include them.
