# Beads command reference (bd 1.4.0-rc.2, HTTP client)

Check `bd <command> --help` when the installed version differs.

## Claims and leases

- `bd update <id> --claim` atomically sets you as assignee and the status to
  `in_progress`. If someone else holds the claim, it fails with "already
  claimed by …". Re-claiming your own claim is a no-op.
- `bd ready --claim [-l label]` claims the first ready issue that matches.
- A claim carries a lease (default TTL 5 minutes), refreshed by
  `bd heartbeat <id>`. The lease does **not** release the claim by itself.
  Only `bd reclaim` reverts stale leases to `open`. If another system (for
  example T3) is the authority on whether a run is alive, do not run
  `bd reclaim`. Check that system and release the claim deliberately. Over
  HTTP, `bd unclaim` is not supported: use
  `bd update <id> --status open --assignee ""`.
- The lease TTL is fixed at 5 minutes. bd-board lists in-progress issues by
  assignee and marks the assignee as an agent once a heartbeat follows the
  claim. Leto's `bd-hold` keeps the lease alive while the agent's process runs.
- `bd ready --claim` claims the first match. When a brief names the issue,
  claim that issue by ID instead.
- Conditional writes: `--if-assignee <actor>` / `--if-status <s>` exit 13 on
  mismatch and write nothing.

## Metadata, notes, references

- `--set-metadata k=v` (repeatable), `--unset-metadata k`, `--metadata '{json}'`.
  Filter with `bd list --has-metadata-key k` or `--metadata-field k=v`.
- `--external-ref <ref>` stores one external link (PR URL, ticket).
- `--append-notes "..."` appends; `--notes` replaces.
- `bd comments add <id> "..."` keeps a dated, attributed trail. Use it for run
  history.

## Dependencies

- `bd dep add A B`: A depends on (is blocked by) B. Equivalent:
  `--blocked-by B` or `--depends-on B`.
- At creation: `--deps blocked-by:B,discovered-from:C`, or `blocks:X` for
  the reverse direction. `--parent <epic>` creates a parent-child edge.
- `bd dep tree <id>`, `bd graph <id> [--compact|--box|--dot|--html]`,
  `bd graph --all --open`.
- JSON shape: each issue may carry `dependencies: [{issue_id, depends_on_id,
  type}]`, where `issue_id` waits for `depends_on_id`.

## Gates

`bd gate list|check|resolve`. Types: `human`, `timer`, `gh:run`, `gh:pr`,
`bead`. Gates are usually created by formula steps. For simple human
sign-off, a blocking issue that the user closes is often clearer than a gate.
Resolve a gate only after the real condition or decision has happened.

## Read-only SQL

`bd sql "<SELECT ...>"` runs against the live database. Use it for reads
only. Useful tables are `issues`, `dependencies` (`issue_id`,
`depends_on_issue_id`, `type`), `labels`, `comments`, `events`,
`ready_issues` and `blocked_issues`. Dolt history:
`SELECT * FROM dolt_log LIMIT 10` and `... AS OF 'HEAD~5'`.

## Export

`bd export -o <file>` writes a JSONL snapshot for interop or offline
analysis. It is not a backup. Use the operator's Dolt-native backups for
recovery.
