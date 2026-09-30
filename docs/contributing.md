# Contributing and updating

## Source of truth

This repository is the canonical implementation. Installed skills are deployment copies, not the primary place to maintain changes.

When a consuming project discovers an issue or improvement, bring the suggestion back here with a reproducible example. Review local installation changes before porting them; do not blindly overwrite canonical source.

## Update workflow

1. Update the skill implementation in this repository, including relevant references and regression tests.
2. Run the validation commands in `AGENTS.md`. Check for project names, personal paths, credentials, and unsupported runtime assumptions.
3. Review, commit, and push the source changes to GitHub.
4. Reinstall the changed skill globally from the pushed source:

   ```bash
   skills add leto-labs/skills --global --agent universal --skill t3-orchestration --yes
   # Or, for the other skill:
   skills add leto-labs/skills --global --agent universal --skill bitwarden-secrets --yes
   ```

5. Inspect `skills list --global --agent universal` and compare the installed files with the intended source revision. Check the CLI's global lock metadata rather than assuming a local-path reinstall updated remote tracking. Do not hand-edit hashes to hide drift.

Project-local installations are independent: update them from their consuming project root without `--global`. `skills update --global` is an alternative when updating all CLI-managed global skills is intended.

## Review boundaries

- Keep the two skills independently installable.
- Keep tool-specific defaults documented and overridable. Never assume an account has access to a particular model or service tier.
- Test helper changes without live mutations first. Live secret updates, thread creation, and worktree deletion require appropriate authorization.
- Never include real secret values or private conversation exports in fixtures.
- This repository uses the MIT license. Before accepting externally sourced code, review its origin, license compatibility, and any attribution requirements.
