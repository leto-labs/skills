# Model selection

## Contents

- [Same-harness policy](#same-harness-policy)
- [Harness detection](#harness-detection)
- [Model selection format](#model-selection-format)
- [Validation](#validation)
- [Examples](#examples)
- [Update the defaults](#update-the-defaults)

## Same-harness policy

A child thread defaults to the same harness as its controller. This does not guarantee the same account: select the provider instance explicitly when account identity matters.

| Harness | Driver | Default instance | Default model | Default options |
| --- | --- | --- | --- | --- |
| Claude | `claudeAgent` | `claudeAgent` | `claude-opus-5-5` | `effort=medium`, `fastMode=true`, `contextWindow=1m` |
| Codex | `codex` | `codex` | `gpt-5.6-terra` | `reasoningEffort=medium`, `serviceTier=priority` |

These are bundled presets. Check the live catalog and the user's or project's model and cost policy before using them. If a preset model is unavailable, select an available model with `--model`; do not assume access to a specific model or paid tier. Use `--fast false` to disable the bundled Fast preference. If the requested model belongs to another provider, select its instance with `--model-instance`.

## Harness detection

`t3ctl` uses the first match:

1. `--harness codex|claude`.
2. The `T3_HARNESS` environment variable.
3. `CLAUDECODE=1`. Claude Code sets this variable. The harness is Claude.
4. `CODEX_THREAD_ID`, `CODEX_MANAGED_BY_NPM` or `CODEX_CI`. Codex sets these variables. The harness is Codex.

If no rule matches, create commands stop with a usage error. Give `--harness` or `--model-instance`. Run `t3ctl harness` to see the result of detection without a server connection.

`T3_MODEL_INSTANCE` or `--model-instance` replaces the default instance. The driver of that instance then sets the default model and options.

Limit: T3 does not tell an agent which provider instance runs it. The Codex default is the `codex` instance even when the controller runs on an account instance such as `codex_team_a`. To keep the same account, give `--model-instance`. Run `t3ctl thread <controller-thread-id>` to see the controller instance.

## Model selection format

T3 stores a model selection on each thread:

```json
{
  "instanceId": "claudeAgent",
  "model": "claude-opus-5-5",
  "options": [
    { "id": "effort", "value": "medium" },
    { "id": "fastMode", "value": true },
    { "id": "contextWindow", "value": "1m" }
  ]
}
```

The option IDs depend on the driver. `t3ctl` maps the generic flags to these IDs:

| Flag | Codex option | Claude option |
| --- | --- | --- |
| `--effort` | `reasoningEffort` | `effort` |
| `--fast true\|false` | `serviceTier=priority\|default` | `fastMode=true\|false` |
| `--service-tier` | `serviceTier` | error |
| `--context-window` | no mapping | `contextWindow` |

For any other option, or for a driver without a mapping (Cursor, OpenCode, Grok, Antigravity), use `--option id=value`.

Values that T3 v0.0.42 accepts:

- Codex `reasoningEffort`: `low`, `medium`, `high`, `xhigh`, `max`. Some models also accept `ultra`.
- Codex `serviceTier`: `default`, `priority`. T3 v0.0.42 has no Codex `fastMode` option.
- Claude `effort`: `low`, `medium`, `high`, `xhigh`, `max`, `ultracode`, `ultrathink`. `ultracode` is `xhigh` with multi-agent workflow orchestration. `ultrathink` adds a prompt keyword.
- Claude `fastMode`: boolean. Only some models support it, for example Opus.
- Claude `contextWindow`: `200k`, `1m`.

These lists change with the T3 model manifest. Run `t3ctl models` for the current values.

## Validation

Before it dispatches, `t3ctl` reads the live catalog (`server.getConfig`) and checks:

1. The instance exists and is enabled. If its status is not `ready`, `t3ctl` shows a warning.
2. The model is available on the instance, by slug or by alias.
3. Each option is supported by the model, and its value is permitted.

A default option that the model does not support is removed, with a warning. For example, `claude-sonnet-5` does not support `fastMode`, so `t3ctl` removes `fastMode=true`. An option from an explicit flag that the model does not support causes an error. Nothing is dispatched.

After you create a thread, run `t3ctl thread <thread-id>` and compare `modelSelection` with the request.

## Examples

```bash
# Default for the current harness
t3ctl create-thread --worktree-name docs-audit --description "Audit docs" --prompt "..."

# Claude, high effort, no fast mode
t3ctl create-thread ... --effort high --fast false

# Claude Sonnet 5 with a 200k context window
t3ctl create-thread ... --model claude-sonnet-5 --context-window 200k

# A Codex child from a Claude controller, on a specific Codex account
t3ctl create-thread ... --model-instance codex_team_a --model gpt-6-astra --effort high

# Change the effort of an existing thread for the next turn only
t3ctl send <thread-id> "Continue." --effort xhigh
```

## Update the defaults

The defaults are in `driverDefaults` at the start of `scripts/t3-rpc.ts`. Change them there, then update the table in this file and in `SKILL.md`. Use `t3ctl models` to confirm that the new model and option values exist.

## Account-switch failure in T3 0.0.42

Verified against the running 0.0.42 bundle on September 29, 2026.

The Codex instances can share one `continuation.groupKey`. This means their native conversation storage is compatible. It does not permit simultaneous writers.

`ProviderService.startSession` starts the destination adapter before `stopStaleSessionsForThread` closes the source adapter. A switch can therefore fail with `already has an active writer`.

Do not blindly use `stop` followed by `send --model-instance` as a context-preserving workaround. In this version, the stopped-session path only reuses the persisted resume cursor when the destination instance matches the persisted instance. An account change can start a fresh native conversation while retaining the visible T3 transcript.

1. Export `t3ctl handoff <thread-id>` before recovery.
2. Read the session error and the latest messages.
3. Check `t3ctl providers --refresh --json` for reported usage and continuation groups.
4. Preserve the selected model, effort and service tier explicitly when using `send --model-instance`. The current CLI applies new-instance defaults unless these flags are supplied.
5. If native-session recovery needs a server restart, obtain authorization for the effect on other running threads.
6. Use a transcript-backed continuation only after explaining that it reconstructs context. It does not resume the original native session.

The backend correction needs to capture a compatible resume cursor, close the source writer, and then resume the destination. Failed startup must retain the durable cursor for retry. A stopped-session account switch also needs compatibility checks against the persisted binding. UI transcript retention alone does not prove native context continuity.
