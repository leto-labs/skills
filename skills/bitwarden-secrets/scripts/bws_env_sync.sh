#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Generic .env <-> Bitwarden sync helper.

Usage:
  bws_env_sync.sh env-to-bws --project <name> [--env-file <path>] [--keys K1,K2,...] [--create-project] [--dry-run]
  bws_env_sync.sh bws-to-env --project <name> [--env-file <path>] [--keys K1,K2,...] [--create-env] [--dry-run]

Options:
  --project <name>     Bitwarden project name (required).
  --env-file <path>    Path to .env file (default: ./.env).
  --keys <csv>         Limit sync to comma-separated keys.
  --create-project     Create project when missing (env-to-bws only).
  --create-env         Create .env file when missing (bws-to-env only).
  --bws-bin <path>     bws executable path (default: auto-detect).
  --dry-run            Show planned operations without writing.
  -h, --help           Show this help.

Notes:
  - Requires: bws, jq, and BWS_ACCESS_TOKEN.
  - Never prints secret values.
EOF
}

error() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    error "$cmd is required"
  fi
}

trim_spaces() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf "%s" "$s"
}

quote_env_value() {
  local value="$1"
  # .env files are line-oriented; encode literal newlines explicitly.
  value="${value//$'\n'/\\n}"
  # Single-quote safe output: 'abc'"'"'def'
  printf "'%s'" "$(printf "%s" "$value" | sed "s/'/'\"'\"'/g")"
}

set_env_key() {
  local file="$1"
  local key="$2"
  local value="$3"
  local quoted
  local tmp

  quoted="$(quote_env_value "$value")"
  tmp="$(mktemp)"

  awk -v k="$key" -v v="$quoted" '
    BEGIN {
      pat = "^[[:space:]]*(export[[:space:]]+)?" k "[[:space:]]*="
      replaced = 0
    }
    $0 ~ pat {
      if (replaced == 0) {
        print k "=" v
        replaced = 1
      }
      next
    }
    { print }
    END {
      if (replaced == 0) {
        print k "=" v
      }
    }
  ' "$file" > "$tmp"

  mv "$tmp" "$file"
}

resolve_bws_bin() {
  if [[ -n "$bws_bin" ]]; then
    [[ -x "$bws_bin" ]] || error "bws binary is not executable: $bws_bin"
    return
  fi

  if command -v bws >/dev/null 2>&1; then
    bws_bin="bws"
    return
  fi

  if [[ -x "$HOME/.local/bin/bws" ]]; then
    bws_bin="$HOME/.local/bin/bws"
    return
  fi

  error "bws CLI not found in PATH"
}

parse_key_filter() {
  local raw_key
  local key

  if [[ -z "$keys_csv" ]]; then
    return
  fi

  IFS=',' read -r -a raw_keys <<< "$keys_csv"
  for raw_key in "${raw_keys[@]}"; do
    key="$(trim_spaces "$raw_key")"
    [[ -n "$key" ]] || continue
    key_filter["$key"]=1
  done
}

key_is_selected() {
  local key="$1"
  if [[ ${#key_filter[@]} -eq 0 ]]; then
    return 0
  fi
  [[ -n "${key_filter[$key]:-}" ]]
}

resolve_project_id() {
  local projects_json
  projects_json="$("$bws_bin" project list -o json)"
  project_id="$(echo "$projects_json" | jq -r --arg n "$project_name" '.[] | select(.name == $n) | .id' | head -n1)"

  if [[ -n "$project_id" ]]; then
    return
  fi

  if [[ "$mode" == "env-to-bws" && "$create_project" == "true" ]]; then
    local created_json
    created_json="$("$bws_bin" project create "$project_name" -o json)"
    project_id="$(echo "$created_json" | jq -r '.id')"
    [[ -n "$project_id" ]] || error "failed to create project '$project_name'"
    echo "created project: $project_name"
    return
  fi

  error "project '$project_name' not found or not accessible"
}

collect_env_entries() {
  local file="$1"
  local line
  local key
  local raw
  local value

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue

    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      key="${BASH_REMATCH[2]}"
      raw="${BASH_REMATCH[3]}"
      raw="${raw#"${raw%%[![:space:]]*}"}"
      value="$raw"

      case "$value" in
        \"*\")
          value="${value:1:${#value}-2}"
          value="${value//\\n/$'\n'}"
          value="${value//\\r/$'\r'}"
          value="${value//\\t/$'\t'}"
          value="${value//\\\"/\"}"
          ;;
        \'*\')
          value="${value:1:${#value}-2}"
          ;;
      esac

      if [[ -z "${env_seen[$key]+x}" ]]; then
        env_keys+=("$key")
        env_seen["$key"]=1
      fi
      env_values["$key"]="$value"
    fi
  done < "$file"
}

sync_env_to_bws() {
  [[ -f "$env_file" ]] || error "env file not found: $env_file"

  collect_env_entries "$env_file"
  if [[ ${#env_keys[@]} -eq 0 ]]; then
    echo "no parseable keys found in $env_file"
    return
  fi

  local secrets_json
  local key
  local secret_id
  local value
  local created=0
  local updated=0
  local skipped=0

  secrets_json="$("$bws_bin" secret list "$project_id" -o json)"
  while IFS=$'\t' read -r key secret_id; do
    [[ -n "$key" ]] || continue
    secret_ids_by_key["$key"]="$secret_id"
  done < <(echo "$secrets_json" | jq -r '.[] | [.key, .id] | @tsv')

  for key in "${env_keys[@]}"; do
    if ! key_is_selected "$key"; then
      continue
    fi

    value="${env_values[$key]}"
    secret_id="${secret_ids_by_key[$key]:-}"

    if [[ -n "$secret_id" ]]; then
      if [[ "$dry_run" == "true" ]]; then
        echo "would update: $project_name/$key"
      else
        "$bws_bin" secret edit --value "$value" "$secret_id" -o none
        echo "updated: $project_name/$key"
      fi
      updated=$((updated + 1))
    else
      if [[ "$dry_run" == "true" ]]; then
        echo "would create: $project_name/$key"
      else
        "$bws_bin" secret create "$key" "$value" "$project_id" -o none
        echo "created: $project_name/$key"
      fi
      created=$((created + 1))
    fi
  done

  if [[ ${#key_filter[@]} -gt 0 ]]; then
    skipped=$(( ${#key_filter[@]} - (created + updated) ))
    if (( skipped < 0 )); then skipped=0; fi
  fi

  echo "done: created=$created updated=$updated skipped=$skipped"
}

sync_bws_to_env() {
  local secrets_json
  local key
  local secret_id
  local value
  local synced=0
  local skipped=0

  if [[ ! -f "$env_file" ]]; then
    if [[ "$create_env" == "true" ]]; then
      touch "$env_file"
      echo "created env file: $env_file"
    else
      error "env file not found: $env_file (use --create-env to create it)"
    fi
  fi

  secrets_json="$("$bws_bin" secret list "$project_id" -o json)"
  while IFS=$'\t' read -r key secret_id; do
    [[ -n "$key" ]] || continue

    if ! key_is_selected "$key"; then
      skipped=$((skipped + 1))
      continue
    fi

    if [[ "$dry_run" == "true" ]]; then
      echo "would sync: $project_name/$key -> $env_file"
    else
      value="$("$bws_bin" secret get "$secret_id" -o json | jq -r '.value')"
      set_env_key "$env_file" "$key" "$value"
      echo "synced: $project_name/$key -> $env_file"
    fi
    synced=$((synced + 1))
  done < <(echo "$secrets_json" | jq -r '.[] | [.key, .id] | @tsv')

  echo "done: synced=$synced skipped=$skipped"
}

mode="${1:-}"
if [[ -z "$mode" || "$mode" == "-h" || "$mode" == "--help" ]]; then
  usage
  exit 0
fi
shift || true

project_name=""
env_file=".env"
keys_csv=""
create_project="false"
create_env="false"
dry_run="false"
bws_bin=""

declare -A key_filter=()
declare -A env_values=()
declare -A env_seen=()
declare -A secret_ids_by_key=()
declare -ga env_keys=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      project_name="${2:-}"
      shift 2
      ;;
    --env-file)
      env_file="${2:-}"
      shift 2
      ;;
    --keys)
      keys_csv="${2:-}"
      shift 2
      ;;
    --create-project)
      create_project="true"
      shift
      ;;
    --create-env)
      create_env="true"
      shift
      ;;
    --dry-run)
      dry_run="true"
      shift
      ;;
    --bws-bin)
      bws_bin="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      error "unknown argument: $1"
      ;;
  esac
done

[[ "$mode" == "env-to-bws" || "$mode" == "bws-to-env" ]] || error "mode must be 'env-to-bws' or 'bws-to-env'"
[[ -n "$project_name" ]] || error "--project is required"
[[ -n "${BWS_ACCESS_TOKEN:-}" ]] || error "BWS_ACCESS_TOKEN is not set"

require_cmd jq
require_cmd awk
require_cmd sed
resolve_bws_bin
parse_key_filter
resolve_project_id

case "$mode" in
  env-to-bws)
    sync_env_to_bws
    ;;
  bws-to-env)
    sync_bws_to_env
    ;;
esac
