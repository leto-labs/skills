# Repository instructions

This repository maintains the self-contained `beads` and `bitwarden-secrets` skills.

Before editing, run `git status --short --branch`. Preserve unrelated work. Keep changes inside this repository unless the user asks to update an installation.

## Design

- Use `skill-creator` when adding or revising skills; keep developer skills installed outside this repository.
- Keep each `SKILL.md` concise. Put conditional detail in `references/` and deterministic helpers in `scripts/`.
- Keep installed skills independent of repository-level docs and other skills.
- Do not include personal paths, real project/account examples, credentials, source caches, or runtime exports.
- Keep project-specific policies in consuming projects, not shared skills.
- Do not add third-party skill snapshots or a root `skills-lock.json`.
- Preserve user choices and require authorization for destructive or externally visible actions.

## Validation

```bash
bash -n skills/bitwarden-secrets/scripts/bws_env_sync.sh
python3 -m py_compile skills/beads/scripts/bd_mermaid.py
git diff --check
```

Validate skill frontmatter with the installed skill-creator validator when available. Run secret scanning before publication and review both current files and history.

See `docs/contributing.md` for the source-to-installation update workflow.
