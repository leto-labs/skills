# Bitwarden Secrets Operations

## Prerequisites

- `bws` CLI installed
- `jq` installed
- `BWS_ACCESS_TOKEN` set

Check:

```bash
bws --version
bws project list -o table
```

## Generic Sync Script

Use the consolidated helper:

```bash
scripts/bws_env_sync.sh --help
```

Modes:

```bash
# .env -> Bitwarden (upsert keys from env file into project)
scripts/bws_env_sync.sh env-to-bws --project <project-name> --env-file <path-to-env> --create-project

# Bitwarden -> .env (upsert project secrets into env file)
scripts/bws_env_sync.sh bws-to-env --project <project-name> --env-file <path-to-env> --create-env
```

Optional filters:

```bash
# Limit to a subset of keys
scripts/bws_env_sync.sh env-to-bws --project <project-name> --env-file <path-to-env> --keys KEY_A,KEY_B
scripts/bws_env_sync.sh bws-to-env --project <project-name> --env-file <path-to-env> --keys KEY_A,KEY_B

# Preview changes without writing
scripts/bws_env_sync.sh env-to-bws --project <project-name> --env-file <path-to-env> --dry-run
scripts/bws_env_sync.sh bws-to-env --project <project-name> --env-file <path-to-env> --dry-run
```

## Raw `bws` Commands

### List projects

```bash
bws project list -o table
```

### Create project

```bash
bws project create <project-name>
```

### List secrets in project

```bash
bws secret list <project-id> -o json | jq -r '.[].key'
```

## Runtime Patterns

### Pattern A: Wrapper injection

```bash
bws run -- <command>
```

### Pattern B: On-demand fetch

- Keep only `BWS_ACCESS_TOKEN` in machine env
- Fetch individual secrets with `bws secret get` as needed
- Prefer this for least-privilege runtime behavior
