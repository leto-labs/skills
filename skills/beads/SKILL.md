---
name: beads
description: "Track and coordinate work in a Beads (bd) issue ledger backed by Dolt. Use when the user mentions beads, bd, the ledger, coordination ledger, ready work, lanes, milestones, epics, blockers, dependency graphs, claiming or handing off tasks, or asks to show tasks, plan work across projects, or draw a dependency diagram. Covers verifying which database bd targets, loading workspace policy with bd prime, creating and updating issues, claims, dependencies, comments and metadata, extracting data as JSON, and rendering tables or Mermaid diagrams in chat."
---

# Beads

Beads (`bd`) is a dependency-aware issue tracker for agents. It stores issues,
dependencies, comments and history in a Dolt SQL database. Use the CLI. Do
not install the Beads MCP server, editor plugin, hooks or viewer unless the
user asks.

## 1. Confirm the target first

```bash
bd where        # resolved .beads directory, prefix, database
bd ping         # server reachable
```

- Leto hosts use one shared ledger through an HTTP client directory
  (`BEADS_DIR=~/.local/share/leto-ledger-client/.beads`), whatever your cwd.
  Trust `bd where`, not your cwd.
- If `bd` resolves to an unexpected project-local `.beads/`, or reports no
  database, stop and tell the user. Never run `bd init` to "fix" it. That
  creates a second database.

## 2. Load workspace policy once

Run `bd prime` once per session before you plan, claim or close work. It
prints the workspace workflow, which overrides the defaults in this skill:
labels, title format, who may write, how to claim and hand off, and metadata
keys.

A worker given a bead ID claims it (`bd-hold claim <id>` on Leto hosts), reads
`bd show <id> --json`, does the work, hands the claim back to its parent and
reports. Workers do not create issues unless their brief says so.

## 3. Everyday commands

Prefer `--json` for anything you will parse. Summarize in chat. Do not paste
raw JSON.

| Goal | Command |
|---|---|
| What can start now | `bd ready --type task --json [-l project:x]` (without `--type`, epics too) |
| List / filter | `bd list --json [-s open,in_progress] [-l label] [--all]` |
| One issue | `bd show <id> --json` |
| Create a lane | `bd create "<title>" -t task -p 2 --labels <l> [--parent <epic>] [--deps blocked-by:<id>] [--acceptance "..."] --json` |
| Milestone | `bd create "<title>" -t epic ...` |
| Claim (atomic) | `bd-hold claim <id>` on Leto hosts (claim + T3 link + lease keeper); otherwise `bd update <id> --claim` |
| Hand back | `bd-hold handoff <id> --to <parent> --note "..."`, or `bd-hold release <id> --note "..."` |
| Record binding | `bd update <id> --set-metadata key=value ...` |
| Progress note | `bd comments add <id> "..."` |
| Dependency | `bd dep add <id> <prerequisite>` (`<id>` waits for the prerequisite) |
| Why blocked | `bd ready --explain`, `bd blocked --json` |
| Tree / graph | `bd dep tree <epic> --direction up` (lanes), `bd dep tree <id>` (prerequisites), `bd graph <epic> --compact` |
| Close | `bd close <id> --reason "..."` |
| History | `bd history <id>` |

Set `BEADS_ACTOR` to a stable identity before writing, or pass `--actor`. On
Leto hosts use the actor that `bd-hold whoami` prints for your T3 thread.

See `references/commands.md` for claim/lease semantics, metadata, gates and
read-only SQL.

## 4. Showing work to the user

- **Tables:** render ID, title, status, priority and assignee from
  `bd list --json` as a Markdown table. Group by label or parent when there
  are many rows.
- **Dependency diagrams:** pipe JSON into the bundled helper and paste the
  Mermaid result:

  ```bash
  bd list --all --json | python3 <skill-dir>/scripts/bd_mermaid.py [--label project:x] [--no-closed]
  ```

  Arrows point from a prerequisite to the issue it unblocks. Dotted arrows
  are parent→child.
- For a one-off terminal view: `bd graph <epic> --compact`, or
  `bd graph --all --open`.

## 5. Keep the ledger small

- One issue per durable deliverable (a lane: one complete deliverable with one
  handoff). Never one per shell command, retry, review round or chat turn.
- Append to the existing issue (comments, metadata) instead of creating
  follow-ups. Create a follow-up only if it is independently valuable.
- Close with a reason only when acceptance is met. Superseded work is closed
  with the replacement ID.
- Ledger state never grants permission to merge, push, deploy or delete.

## 6. Avoid unless the user asks

`bd init`, `setup`, `hooks`, `migrate`, `purge`, `flatten`, `compact`,
`prune`, `gc`, `delete`, `reclaim`, `rename-prefix`, `dolt push/pull`,
`federation`, `sync`, tracker integrations (`github`, `jira`, `linear`, …),
`remember`/`memories`, formulas, molecules and wisps. The HTTP backend refuses
some commands outright, for example `bd unclaim` (use
`bd update <id> --status open --assignee ""`) and `--spec-id` (use
`--external-ref`).
