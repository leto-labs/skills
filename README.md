# Agent Skills

Two self-contained agent skills maintained by Leto Labs:

| Skill | Purpose | Requirements |
| --- | --- | --- |
| [bitwarden-secrets](skills/bitwarden-secrets/SKILL.md) | Manage Bitwarden Secrets Manager credentials and sync selected keys with `.env` files. | Bash 4+, `bws`, `jq`, a scoped machine-account token |
| [t3-orchestration](skills/t3-orchestration/SKILL.md) | Inspect and control T3 Code threads, worktrees, providers, approvals, and handoffs through `t3ctl`. | A running T3 Code server; Node 22.18+ or `tsx`; see the skill for authentication |

Each skill contains its own instructions, references, and executable helpers. Install either independently. T3 integration was tested against v0.0.42; its internal API can change between releases. Model availability depends on your provider configuration.

## Install

Install the skills CLI if needed:

```bash
pnpm add -g skills
```

Install both skills at user level using the universal agent target:

```bash
skills add leto-labs/skills --global --agent universal --skill bitwarden-secrets --skill t3-orchestration --yes
```

Omit `--global` for a project-local install. Select just one `--skill` to install it independently. User-level universal installs use `~/.agents/skills/`; project-level installs use `.agents/skills/`.

Inspect available skills or update installed copies:

```bash
skills add leto-labs/skills --list --full-depth
skills update --global
```

Updates may include other CLI-managed global skills. To refresh only these two, repeat the explicit installation command above.

## Layout

```text
skills/
  bitwarden-secrets/   SKILL.md, references, Bash sync helper
  t3-orchestration/    SKILL.md, references, t3ctl helper and tests
docs/
  contributing.md     Validation and source-to-installation update workflow
```

This is a source repository, not a consuming project: no root skill lockfile, vendor snapshots, machine configuration, or runtime data belong here.

## Safety

These skills can modify secrets, threads, and worktrees. Read their instructions, use scoped credentials, and preview operations where supported. Never commit tokens, cookies, `.env` files, or exported conversations. Installations do not grant permission to publish, delete data, or interrupt unrelated work.

See [contributing](docs/contributing.md) for development and updates. A distribution license has not yet been selected.
