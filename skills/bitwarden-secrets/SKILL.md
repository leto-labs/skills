---
name: bitwarden-secrets
description: "Manage machine credentials in Bitwarden Secrets Manager with bws CLI. Use when user mentions Bitwarden Secrets Manager, bws, machine accounts, BWS_ACCESS_TOKEN, migrating .env keys, secret rotation, project scoping, credential bootstrap, or secure secret storage for applications and CI. Handles project setup, create/update/list/delete secrets, env migration, and secure runtime patterns without exposing secret values."
---

# Bitwarden Secrets

Manage credentials in Bitwarden Secrets Manager using `bws`.

## What this skill does

1. Set up and verify Bitwarden Secrets Manager access (`bws`, `BWS_ACCESS_TOKEN`)
2. Create/update/list/delete secrets safely
3. Sync secrets between Bitwarden projects and `.env` files in either direction
4. Guide runtime usage (`bws run` vs on-demand fetch)
5. Enforce secret-safety guardrails

## Safety requirements (non-negotiable)

- Never print secret values in chat responses.
- Never commit secrets to git.
- Report only key names and operation results (`created/updated/deleted`).
- Treat management/super tokens as restricted credentials.

See `references/security.md` for full guardrails.

## Quick workflow

### 1) Verify prerequisites

- `bws` installed
- `jq` available
- `BWS_ACCESS_TOKEN` set

If not, install and configure before proceeding.

### 2) Sync local env file to Bitwarden project

Run:

```bash
scripts/bws_env_sync.sh env-to-bws --project <project-name> --env-file <path-to-env> --create-project
```

### 3) Sync Bitwarden project back into env file

Run:

```bash
scripts/bws_env_sync.sh bws-to-env --project <project-name> --env-file <path-to-env> --create-env
```

### 4) Optional key filtering

```bash
scripts/bws_env_sync.sh env-to-bws --project <project-name> --env-file <path-to-env> --keys KEY_A,KEY_B
scripts/bws_env_sync.sh bws-to-env --project <project-name> --env-file <path-to-env> --keys KEY_A,KEY_B
```

### 5) Verify without exposing values

Filter the JSON output to key names before displaying it:

```bash
bws secret list <project-id> -o json | jq -r '.[].key'
```

## Runtime patterns

### Pattern A: wrapper injection

```bash
bws run -- <command>
```

### Pattern B: on-demand fetch (preferred for least privilege)

- Keep only `BWS_ACCESS_TOKEN` in runtime env
- Fetch specific secret when needed via `bws secret get`

Use Pattern B for worker pools that should not see all secrets.

## References

- `references/operations.md` — command patterns for project + `.env` sync
- `references/security.md` — guardrails, rotation, incident response
- `scripts/bws_env_sync.sh` — generic `.env` <-> Bitwarden sync helper
