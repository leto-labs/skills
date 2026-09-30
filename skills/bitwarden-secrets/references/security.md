# Bitwarden Security Guardrails

## Golden Rules

1. Never print secret values in chat output.
2. Never commit secrets to git (`.env`, scripts, logs, markdown).
3. Prefer scoped machine accounts per environment.
4. Rotate high-privilege tokens regularly.
5. Use project boundaries to limit blast radius.

## Access Design

- Create separate machine accounts per runtime:
  - `app-production`
  - `background-workers`
  - `ci`
- Assign each machine account to only required projects.
- Do not give worker pools access to management/super tokens unless required.

## High-Risk Token Pattern

For management tokens (e.g., Cloudflare management token):

1. Store management token in restricted project.
2. Use it to mint scoped token for a specific task/resource.
3. Store scoped token in lower-privilege project.
4. Use scoped token for runtime operations.
5. Revoke scoped token when task completes.

## Rotation Workflow

1. Create replacement credential in provider.
2. Update secret in Bitwarden (`bws secret edit`).
3. Restart/reload dependent service.
4. Validate service behavior.
5. Revoke old credential.

## Audit & Incident Response

- Use Bitwarden event/audit logs to track secret access.
- On suspected leak:
  1. Rotate affected secret immediately.
  2. Revoke machine account token if needed.
  3. Review access logs for scope and timeline.
  4. Reissue scoped credentials.

## Chat Safety

When reporting results:
- Report `project/key` names and action (`created`, `updated`, `deleted`)
- Do not include values
- Redact IDs if user does not need exact IDs
