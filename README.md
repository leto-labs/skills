# Agent Skills

A self-contained agent skill maintained by Leto Labs:

| Skill | Purpose | Requirements |
| --- | --- | --- |
| [bitwarden-secrets](skills/bitwarden-secrets/SKILL.md) | Manage Bitwarden Secrets Manager credentials and sync selected keys with `.env` files. | Bash 4+, `bws`, `jq`, a scoped machine-account token |

The skill contains its own instructions, references, and executable helpers.

## Install

Install the skills CLI if needed:

```bash
pnpm add -g skills
```

Install the skill at user level using the universal agent target:

```bash
skills add leto-labs/skills --global --agent universal --skill bitwarden-secrets --yes
```

Omit `--global` for a project-local install. User-level universal installs use `~/.agents/skills/`; project-level installs use `.agents/skills/`.

Inspect available skills or update installed copies:

```bash
skills add leto-labs/skills --list --full-depth
skills update --global
```

Updates may include other CLI-managed global skills. To refresh only this skill, repeat the explicit installation command above.

## Layout

```text
skills/
  bitwarden-secrets/   SKILL.md, references, Bash sync helper
docs/
  contributing.md     Validation and source-to-installation update workflow
```

This is a source repository, not a consuming project: no root skill lockfile, vendor snapshots, machine configuration, or runtime data belong here.

## Safety

This skill can modify secrets. Read its instructions, use scoped credentials, and preview operations where supported. Never commit tokens, cookies, or `.env` files. Installation does not grant permission to publish, delete data, or interrupt unrelated work.

See [contributing](docs/contributing.md) for development and updates.

## License

[MIT](LICENSE) — Copyright (c) 2026 Leto Labs.
