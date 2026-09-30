#!/usr/bin/env -S node --no-warnings
// t3-rpc.ts: command-line control of a running T3 Code server (verified against T3 Code v0.0.42).
// Run it through the `t3ctl` wrapper in this directory. See ../references/cli.md.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type OptionValue = string | boolean;
type Flags = Record<string, string | boolean | string[]>;

interface ModelSelection {
  instanceId: string;
  model: string;
  options?: Array<{ id: string; value: OptionValue }>;
}

type Driver = "codex" | "claudeAgent" | string;
type Harness = "codex" | "claude";

interface OptionEntry {
  value: OptionValue;
  // "default" entries come from the harness defaults. The validator drops them with a
  // warning when the model does not support them. "explicit" entries come from flags and
  // cause an error when they are not supported.
  source: "default" | "explicit" | "inherited";
}

interface ModelRequest {
  instanceId?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  serviceTier?: string;
  contextWindow?: string;
  extra: Array<[string, OptionValue]>;
}

interface ThreadLike {
  id?: string;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  backgroundLiveness?: "working" | "monitoring" | null;
  createdAt?: string;
  updatedAt?: string;
  latestUserMessageAt?: string | null;
  title?: string | null;
  projectId?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  interactionMode?: string | null;
  runtimeMode?: string | null;
  modelSelection?: ModelSelection | null;
  session?: { status?: string | null } | null;
  latestTurn?: { status?: string | null; state?: string | null } | null;
  deletedAt?: string | null;
  archivedAt?: string | null;
}

interface ProjectLike {
  id: string;
  title?: string;
  workspaceRoot?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  [key: string]: unknown;
}

interface ShellSnapshot {
  snapshotSequence?: number;
  projects: ProjectLike[];
  threads: ThreadLike[];
  updatedAt?: string;
}

interface ProviderOptionDescriptor {
  id: string;
  type?: string;
  options?: Array<{ id: string; isDefault?: boolean }>;
}

interface ProviderModel {
  slug: string;
  aliases?: string[];
  capabilities?: { optionDescriptors?: ProviderOptionDescriptor[] };
}

interface ProviderInstance {
  instanceId: string;
  driver: string;
  displayName?: string;
  enabled?: boolean;
  status?: string;
  version?: string | null;
  models?: ProviderModel[];
  continuation?: { groupKey?: string };
  usageLimits?: {
    checkedAt: string;
    windows: Array<{ id: string; kind?: string; label?: string; usedPercent?: number; resetsAt?: string; windowDurationMins?: number }>;
    resetCredits?: { availableCount: number; nextExpiresAt?: string };
    unavailable?: { reason: string; message?: string };
  };
}

class CliError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const baseUrl = process.env.T3_BASE_URL ?? "http://127.0.0.1:3773";
const url = new URL(baseUrl);
const wsUrl = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/ws`;
const cookieName = process.env.T3_COOKIE_NAME ?? `t3_session_${url.port || "80"}`;
const cookieDb = process.env.T3_COOKIE_DB ?? `${homedir()}/.config/t3code/Cookies`;
const autoTokenEnabled = process.env.T3_AUTO_TOKEN !== "0";
const autoTokenTtl = process.env.T3_AUTO_TOKEN_TTL ?? "15m";

const worktreeNamePattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const approvalDecisions = new Set(["accept", "acceptForSession", "decline", "cancel"]);
const interactionModes = new Set(["default", "plan"]);

// Default model per provider driver. The default policy is "same harness": a Codex agent
// spawns Codex threads and a Claude agent spawns Claude threads.
const driverDefaults: Record<string, { instanceId: string; model: string; effort: string; fast: boolean; contextWindow?: string }> = {
  codex: { instanceId: "codex", model: "gpt-5.6-terra", effort: "medium", fast: true },
  claudeAgent: { instanceId: "claudeAgent", model: "claude-opus-5-5", effort: "medium", fast: true, contextWindow: "1m" },
};

const harnessDriver: Record<Harness, Driver> = { codex: "codex", claude: "claudeAgent" };

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const usageText = `Usage: t3ctl <command> [arguments] [flags]

Inspect:
  doctor                             Check auth, server, orchestration and harness detection
  harness                            Show the detected harness and its default model selection (offline)
  providers [--instance <id>] [--refresh] [--all] [--json]
                                     Show provider readiness, reported usage and reset times
  models [--instance <id>] [--json]  List provider instances, models and model options
  projects [--search <text|path>] [--active] [--limit N] [--json]
  threads [filters] [--sort updated|created|message|title] [--reverse] [--limit N] [--json]
      filters: --project <id|title|path> --state running,working,monitoring,attention,error,idle,new,archived
               --harness codex,claude --instance <ids> --model <slugs> --branch <text>
               --worktree <path> --search <title text> --since <30m|2h|7d> --all --archived
  thread <thread-id|worktree-path>   Show one thread as JSON, with its derived state
  history <thread-id|worktree-path> [--turns N] [--before <cursor>] [--all] [--activities[=all]]
          [--user-only] [--max-chars N] [--json] [--out <file>]
  search <query> [--limit N] [--json] Full-text search of user and assistant messages
  wait <thread-id> [--timeout 30m] [--interval 15s] [--until-quiet]
                                     Wait while the thread is running or working. --until-quiet also waits
                                     through monitoring (watch loops). Exit 3 on timeout
  snapshot                           Print the merged active and archived shell snapshot

Create threads:
  create-thread --description <text> (--prompt <text> | --prompt-file <file>) (--worktree-name <slug> | --branch <branch>) [flags]
  create-shared-thread --worktree-name <slug> --description <text> (--prompt | --prompt-file) [--worktree-path <path|null>] [flags]
  continue-thread <thread-id|worktree-path> (--prompt | --prompt-file) [--description <text>] [--allow-running] [flags]
                                     New thread in the same checkout and branch, with the caller's harness by default
  handoff <thread-id|worktree-path> [--out <dir>] [--turns N] [--base-branch main]
                                     Write metadata, transcripts and git state for a continuation brief

Operate threads:
  send <thread-id> <message> [--interaction-mode <default|plan>] [model flags] [--dry-run]
  interrupt <thread-id> [turn-id]
  stop <thread-id>
  set-mode <thread-id> [--interaction-mode <default|plan>] [--runtime-mode <mode>]
  approve <thread-id> <request-id> <accept|acceptForSession|decline|cancel>
  answer <thread-id> <request-id> <answers-json-or-file>
  archive | unarchive | delete <thread-id>
  remove-worktree --project-cwd <path> --worktree-path <path> [--force] [--dry-run]

Low level:
  rpc <method> [payload-json-or-file]
  dispatch <command-json-file>
  uuid

Project flags (create commands):
  --project-id <id>                  Default: the project whose workspaceRoot contains the current git repository
  --project-cwd <path>               Default: the workspaceRoot of that project
  --base-branch <branch>             Default: main (create-thread only)
  --start-from-origin                Create the worktree from origin/<base-branch> (create-thread only)
  --interaction-mode <default|plan>  Default: default (the T3 UI shows it as "Build")
  --runtime-mode <mode>              Default: full-access
  --run-setup-script <true|false>    Default: false
  --dry-run                          Print the command. Do not dispatch it.
  --no-validate                      Do not check the model selection against the live server

Model flags (create commands and send):
  --harness <codex|claude>           Default: the harness that runs this command (T3_HARNESS overrides)
  --model-instance <id>              Provider instance, for example codex, codex_team_a or claudeAgent
  --model <slug>                     Default: gpt-5.6-terra (Codex) or claude-opus-5-5 (Claude)
  --effort <level>                   Default: medium. Alias: --reasoning-effort
  --fast <true|false>                Default: true. Alias: --fast-mode
  --service-tier <default|priority>  Codex only. Overrides --fast
  --context-window <200k|1m>         Claude only. Default: 1m
  --option <id=value>                Any other provider option. Repeat the flag for more options.
`;

function usage(message?: string): never {
  throw new CliError(message ? `${message}\n\n${usageText}` : usageText, 2);
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

interface AuthState {
  mode: "bearer-env" | "cookie" | "bearer-auto" | "none";
  header?: Record<string, string>;
  autoSessionId?: string;
  error?: string;
}

let authState: AuthState | undefined;

function sqlQuote(value: string): string {
  return `'${String(value).replaceAll("'", "''")}'`;
}

// T3 v0.0.42 names the cookie t3_session_<port> or t3_session_<port>_<instanceHash>.
function cookieQuery(): string {
  const host = sqlQuote(url.hostname);
  if (process.env.T3_COOKIE_NAME) {
    return `select name, value from cookies where host_key = ${host} and name = ${sqlQuote(process.env.T3_COOKIE_NAME)} order by creation_utc desc limit 1;`;
  }
  return `select name, value from cookies where host_key = ${host} and (name = ${sqlQuote(cookieName)} or name like ${sqlQuote(`${cookieName}_%`)}) order by creation_utc desc limit 1;`;
}

function readCookie(): string {
  let row: { name?: string; value?: string } | undefined;
  try {
    // node:sqlite is built into Node 22.5 and later. It avoids a dependency on the sqlite3 CLI.
    const { DatabaseSync } = (process as any).getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(cookieDb, { readOnly: true });
    try {
      row = db.prepare(cookieQuery()).get();
    } finally {
      db.close();
    }
  } catch {
    const output = execFileSync("sqlite3", ["-readonly", "-separator", "\t", cookieDb, cookieQuery()], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const [name, value] = output.split("\t");
    row = output ? { name, value } : undefined;
  }
  if (!row?.value) throw new Error(`No ${cookieName} cookie for ${url.hostname} in ${cookieDb}`);
  return `${row.name}=${row.value}`;
}

function findT3Cli(): string | undefined {
  if (process.env.T3_CLI) return process.env.T3_CLI;
  try {
    const onPath = execFileSync("sh", ["-c", "command -v t3"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (onPath) return onPath;
  } catch {
    // Not on PATH. Try the T3 runtime directory.
  }
  const versionsDir = join(process.env.T3CODE_HOME ?? join(homedir(), ".t3"), "runtime", "versions");
  if (!existsSync(versionsDir)) return undefined;
  const versions = readdirSync(versionsDir)
    .filter((name) => existsSync(join(versionsDir, name, "t3")))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latest = versions.at(-1);
  return latest ? join(versionsDir, latest, "t3") : undefined;
}

// Resolve authentication once per process. Order: T3_BEARER_TOKEN, Electron cookie, then a
// short-lived token that this process issues with the t3 CLI and revokes before it exits.
function getAuth(): AuthState {
  if (authState) return authState;
  const envToken = process.env.T3_BEARER_TOKEN?.trim();
  if (envToken) {
    authState = { mode: "bearer-env", header: { Authorization: `Bearer ${envToken}` } };
    return authState;
  }
  const errors: string[] = [];
  if (existsSync(cookieDb)) {
    try {
      authState = { mode: "cookie", header: { Cookie: readCookie() } };
      return authState;
    } catch (error) {
      errors.push(`cookie: ${errorMessage(error)}`);
    }
  } else {
    errors.push(`cookie: ${cookieDb} does not exist`);
  }
  const auto = issueAutoToken(errors);
  if (auto) {
    authState = auto;
    return authState;
  }
  authState = { mode: "none", error: errors.join("; ") };
  return authState;
}

function issueAutoToken(errors: string[]): AuthState | undefined {
  if (!autoTokenEnabled) {
    errors.push("auto token: disabled by T3_AUTO_TOKEN=0");
    return undefined;
  }
  const cli = findT3Cli();
  if (!cli) {
    errors.push("auto token: t3 CLI not found (set T3_CLI)");
    return undefined;
  }
  try {
    const output = execFileSync(cli, [
      "auth", "session", "issue", "--ttl", autoTokenTtl, "--label", "t3ctl", "--json",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const session = JSON.parse(output);
    if (typeof session?.token !== "string" || !session.token) throw new Error("no token in t3 output");
    return {
      mode: "bearer-auto",
      header: { Authorization: `Bearer ${session.token}` },
      autoSessionId: typeof session.sessionId === "string" ? session.sessionId : undefined,
    };
  } catch (error) {
    errors.push(`auto token: ${errorMessage(error).split("\n")[0]}`);
    return undefined;
  }
}

// After a 401: a stale cookie changes to an automatic token, and an expired automatic token
// (long commands such as `wait` outlive T3_AUTO_TOKEN_TTL) is replaced and the old session revoked.
function fallbackAfterUnauthorized(): boolean {
  if (authState?.mode !== "cookie" && authState?.mode !== "bearer-auto") return false;
  const auto = issueAutoToken([]);
  if (!auto) return false;
  if (authState.mode === "cookie") {
    console.error("warning: the T3 cookie was rejected. Using an automatic session token.");
  } else {
    revokeAutoSession();
  }
  authState = auto;
  return true;
}

function authHeaders(): Record<string, string> {
  const auth = getAuth();
  if (!auth.header) throw new Error(`No T3 authentication available (${auth.error})`);
  return auth.header;
}

function revokeAutoSession(): void {
  const sessionId = authState?.autoSessionId;
  if (!sessionId) return;
  const cli = findT3Cli();
  if (!cli) return;
  try {
    execFileSync(cli, ["auth", "session", "revoke", sessionId], { stdio: "ignore" });
  } catch {
    console.error(`warning: could not revoke T3 session ${sessionId}. It expires after ${autoTokenTtl}.`);
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requestJson(path: string, init: RequestInit = {}): Promise<any> {
  const send = () => fetch(new URL(path, baseUrl), { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
  let response = await send();
  if (response.status === 401 && fallbackAfterUnauthorized()) response = await send();
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(`${path} failed ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return await response.json();
}

async function getWebSocketTicket(): Promise<string> {
  const result = await requestJson("/api/auth/websocket-ticket", { method: "POST" });
  if (typeof result?.ticket !== "string" || !result.ticket) {
    throw new Error("T3 websocket-ticket response did not contain a ticket");
  }
  return result.ticket;
}

// Send one Effect RPC request. With `firstChunk`, resolve on the first stream value
// (used for subscriptions such as orchestration.subscribeShell).
async function rpcCall(tag: string, payload: JsonValue, firstChunk: boolean, timeoutMs: number): Promise<any> {
  const ticket = await getWebSocketTicket();
  const requestId = "1";
  return await new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(`${wsUrl}?wsTicket=${encodeURIComponent(ticket)}`);
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
      socket.close();
    };
    const timeout = setTimeout(() => finish(() => reject(new Error(`Timed out waiting for ${tag}`))), timeoutMs);
    socket.addEventListener("open", () => {
      if (settled) return;
      socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
    });
    socket.addEventListener("message", (event) => {
      if (settled) return;
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        finish(() => reject(new Error(`Invalid WebSocket JSON for ${tag}`)));
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message) || typeof message._tag !== "string") {
        finish(() => reject(new Error(`Invalid WebSocket response for ${tag}`)));
        return;
      }
      if (message._tag === "Ping") {
        socket.send(JSON.stringify({ _tag: "Pong" }));
        return;
      }
      if (String(message.requestId) !== requestId) return;
      if (firstChunk && message._tag === "Chunk" && Array.isArray(message.values) && message.values.length > 0) {
        finish(() => resolvePromise(message.values[0]));
        return;
      }
      if (message._tag !== "Exit") return;
      finish(() => {
        if (message.exit?._tag !== "Success") reject(new Error(JSON.stringify(message.exit, null, 2)));
        else if (firstChunk) reject(new Error(`${tag} ended before it produced a stream value`));
        else resolvePromise(message.exit.value);
      });
    });
    socket.addEventListener("error", () => {
      // Runtime errors can include the URL, which contains an authentication ticket.
      finish(() => reject(new Error(`WebSocket error for ${tag}`)));
    });
    socket.addEventListener("close", () => {
      finish(() => reject(new Error(`WebSocket closed before ${tag} completed`)));
    });
  });
}

const rpc = (tag: string, payload: JsonValue = {}) => rpcCall(tag, payload, false, 120000);
const dispatch = (command: JsonValue) => rpc("orchestration.dispatchCommand", command);

async function getShellSnapshot(): Promise<ShellSnapshot> {
  const failures: string[] = [];
  try {
    const [activeItem, archived] = await Promise.all([
      rpcCall("orchestration.subscribeShell", {}, true, 30000),
      rpc("orchestration.getArchivedShellSnapshot", {}),
    ]);
    if (activeItem?.kind !== "snapshot" || !activeItem.snapshot) {
      throw new Error("shell subscription did not begin with a snapshot");
    }
    const active = activeItem.snapshot as ShellSnapshot;
    const archivedSnapshot = archived as ShellSnapshot;
    const projects = new Map<string, ProjectLike>();
    for (const project of [...(archivedSnapshot.projects ?? []), ...(active.projects ?? [])]) projects.set(project.id, project);
    const threads = new Map<string, ThreadLike>();
    for (const thread of [...(archivedSnapshot.threads ?? []), ...(active.threads ?? [])]) {
      if (thread.id) threads.set(thread.id, thread);
    }
    return {
      snapshotSequence: Math.max(Number(active.snapshotSequence ?? 0), Number(archivedSnapshot.snapshotSequence ?? 0)),
      projects: Array.from(projects.values()),
      threads: Array.from(threads.values()),
      updatedAt: [active.updatedAt, archivedSnapshot.updatedAt].filter(Boolean).sort().at(-1) ?? now(),
    };
  } catch (error) {
    failures.push(`shell RPCs: ${errorMessage(error)}`);
  }
  try {
    const snapshot = await requestJson("/api/orchestration/snapshot");
    return { ...snapshot, projects: snapshot.projects ?? [], threads: snapshot.threads ?? [] };
  } catch (error) {
    failures.push(`HTTP snapshot: ${errorMessage(error)}`);
  }
  throw new Error(`Unable to read T3 orchestration state (${failures.join("; ")})`);
}

async function getProviders(): Promise<ProviderInstance[]> {
  const config = await rpc("server.getConfig", {});
  return Array.isArray(config?.providers) ? config.providers : [];
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

const repeatableFlags = new Set(["option"]);

function parseFlags(args: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let value: string | boolean;
    const eq = key.indexOf("=");
    if (eq > 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        value = true;
      } else {
        value = next;
        index += 1;
      }
    }
    if (!key) usage("Empty flag name");
    if (repeatableFlags.has(key)) {
      const list = (flags[key] as string[] | undefined) ?? [];
      if (typeof value !== "string") usage(`--${key} needs a value`);
      list.push(value);
      flags[key] = list;
    } else {
      flags[key] = value;
    }
  }
  return { flags, positional };
}

function stringFlag(flags: Flags, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value === true) usage(`--${key} needs a value`);
  }
  return undefined;
}

function requireFlag(flags: Flags, key: string): string {
  const value = stringFlag(flags, key);
  if (!value) usage(`Missing required --${key}`);
  return value;
}

function booleanFlag(flags: Flags, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = flags[key];
    if (value === undefined) continue;
    if (value === true || value === "true") return true;
    if (value === "false") return false;
    usage(`--${key} expects true or false, got ${String(value)}`);
  }
  return undefined;
}

function parseOptionValue(raw: string): OptionValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

async function parseJsonArg(value: string | undefined): Promise<JsonValue> {
  if (value === undefined) return {};
  const text = value.trim().startsWith("{") || value.trim().startsWith("[") ? value : await readFile(value, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`Invalid JSON: ${errorMessage(error)}`, 2);
  }
}

function interactionModeFlag(flags: Flags): string | undefined {
  const mode = stringFlag(flags, "interaction-mode");
  if (mode && !interactionModes.has(mode)) usage(`--interaction-mode must be one of: ${[...interactionModes].join(", ")}`);
  return mode;
}

function now(): string {
  return new Date().toISOString();
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// Harness detection and model selection
// ---------------------------------------------------------------------------

function detectHarness(flags: Flags): { harness?: Harness; source: string } {
  const requested = stringFlag(flags, "harness") ?? process.env.T3_HARNESS?.trim();
  if (requested) {
    if (requested !== "codex" && requested !== "claude") usage(`--harness must be codex or claude, got ${requested}`);
    return { harness: requested, source: stringFlag(flags, "harness") ? "--harness" : "T3_HARNESS" };
  }
  if (process.env.CLAUDECODE === "1") return { harness: "claude", source: "CLAUDECODE" };
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_MANAGED_BY_NPM || process.env.CODEX_CI) {
    return { harness: "codex", source: "CODEX_* environment" };
  }
  return { source: "none" };
}

function inferDriver(instanceId: string, providers?: ProviderInstance[]): Driver {
  const live = providers?.find((provider) => provider.instanceId === instanceId);
  if (live) return live.driver;
  if (instanceId.startsWith("codex")) return "codex";
  if (instanceId.startsWith("claude")) return "claudeAgent";
  return instanceId;
}

function readModelRequest(flags: Flags): ModelRequest {
  const extra: Array<[string, OptionValue]> = [];
  for (const raw of (flags.option as string[] | undefined) ?? []) {
    const eq = raw.indexOf("=");
    if (eq <= 0) usage(`--option expects id=value, got ${raw}`);
    extra.push([raw.slice(0, eq), parseOptionValue(raw.slice(eq + 1))]);
  }
  return {
    instanceId: stringFlag(flags, "model-instance"),
    model: stringFlag(flags, "model"),
    effort: stringFlag(flags, "effort", "reasoning-effort"),
    fast: booleanFlag(flags, "fast", "fast-mode"),
    serviceTier: stringFlag(flags, "service-tier"),
    contextWindow: stringFlag(flags, "context-window"),
    extra,
  };
}

function hasModelRequest(request: ModelRequest): boolean {
  return Boolean(request.instanceId || request.model || request.effort || request.serviceTier || request.contextWindow)
    || request.fast !== undefined || request.extra.length > 0;
}

// Map generic intent (effort, fast, context window) to provider option ids.
function applyRequestOptions(
  driver: Driver,
  options: Map<string, OptionEntry>,
  input: { effort?: string; fast?: boolean; serviceTier?: string; contextWindow?: string },
  source: OptionEntry["source"],
): void {
  if (driver === "codex") {
    if (input.effort) options.set("reasoningEffort", { value: input.effort, source });
    const tier = input.serviceTier === "fast" ? "priority" : input.serviceTier;
    if (tier) options.set("serviceTier", { value: tier, source });
    else if (input.fast !== undefined) options.set("serviceTier", { value: input.fast ? "priority" : "default", source });
    return;
  }
  if (driver === "claudeAgent") {
    if (input.effort) options.set("effort", { value: input.effort, source });
    if (input.fast !== undefined) options.set("fastMode", { value: input.fast, source });
    if (input.contextWindow) options.set("contextWindow", { value: input.contextWindow, source });
    if (input.serviceTier && source === "explicit") throw new CliError("--service-tier applies only to Codex instances", 2);
    return;
  }
  if (source === "explicit" && (input.effort || input.fast !== undefined || input.serviceTier || input.contextWindow)) {
    throw new CliError(`Driver ${driver} has no built-in option mapping. Use --option id=value.`, 2);
  }
}

// Build a model selection for a new thread: harness defaults, then explicit flags.
function resolveNewSelection(flags: Flags, providers?: ProviderInstance[]): { instanceId: string; model: string; options: Map<string, OptionEntry>; driver: Driver } {
  const request = readModelRequest(flags);
  const { harness } = detectHarness(flags);
  const instanceId = request.instanceId
    ?? process.env.T3_MODEL_INSTANCE?.trim()
    ?? (harness ? driverDefaults[harnessDriver[harness]].instanceId : undefined);
  if (!instanceId) {
    throw new CliError(
      "Cannot detect the calling harness. Pass --harness codex|claude or --model-instance <id> (see `t3ctl models`).",
      2,
    );
  }
  const driver = inferDriver(instanceId, providers);
  const defaults = driverDefaults[driver];
  const model = request.model ?? defaults?.model;
  if (!model) throw new CliError(`No default model for driver ${driver}. Pass --model.`, 2);
  const options = new Map<string, OptionEntry>();
  if (defaults) {
    applyRequestOptions(driver, options, { effort: defaults.effort, fast: defaults.fast, contextWindow: defaults.contextWindow }, "default");
  }
  applyRequestOptions(driver, options, request, "explicit");
  for (const [id, value] of request.extra) options.set(id, { value, source: "explicit" });
  return { instanceId, model, options, driver };
}

// Build a model selection for a follow-up turn: keep the thread's selection, then apply flags.
function resolveFollowUpSelection(flags: Flags, thread: ThreadLike, providers?: ProviderInstance[]) {
  const request = readModelRequest(flags);
  const current = thread.modelSelection;
  if (!current || (request.instanceId && request.instanceId !== current.instanceId)) {
    return resolveNewSelection(flags, providers);
  }
  const driver = inferDriver(current.instanceId, providers);
  const options = new Map<string, OptionEntry>();
  for (const option of current.options ?? []) options.set(option.id, { value: option.value, source: "inherited" });
  applyRequestOptions(driver, options, request, "explicit");
  for (const [id, value] of request.extra) options.set(id, { value, source: "explicit" });
  return { instanceId: current.instanceId, model: request.model ?? current.model, options, driver };
}

// Check the selection against the live provider catalog. Drop unsupported default options
// with a warning. Reject unsupported explicit options.
function validateSelection(
  selection: { instanceId: string; model: string; options: Map<string, OptionEntry> },
  providers: ProviderInstance[],
): string[] {
  const warnings: string[] = [];
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!provider) {
    const known = providers.filter((candidate) => candidate.enabled).map((candidate) => candidate.instanceId).join(", ");
    throw new CliError(`Unknown provider instance ${selection.instanceId}. Enabled instances: ${known}`);
  }
  if (provider.enabled === false) throw new CliError(`Provider instance ${selection.instanceId} is disabled`);
  if (provider.status && provider.status !== "ready") warnings.push(`provider instance ${selection.instanceId} status is ${provider.status}`);
  const models = provider.models ?? [];
  const model = models.find((candidate) => candidate.slug === selection.model)
    ?? models.find((candidate) => candidate.aliases?.some((alias) => alias.toLowerCase() === selection.model.toLowerCase()));
  if (!model) {
    throw new CliError(`Model ${selection.model} is not available on ${selection.instanceId}. Available: ${models.map((m) => m.slug).join(", ")}`);
  }
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  for (const [id, entry] of [...selection.options]) {
    const descriptor = descriptors.find((candidate) => candidate.id === id);
    let problem: string | undefined;
    if (!descriptor) {
      problem = `option ${id} is not supported by ${model.slug}`;
    } else if (descriptor.type === "boolean" && typeof entry.value !== "boolean") {
      problem = `option ${id} expects true or false`;
    } else if (descriptor.type === "select" && !descriptor.options?.some((choice) => choice.id === entry.value)) {
      problem = `option ${id}=${String(entry.value)} is not valid for ${model.slug}. Valid: ${descriptor.options?.map((choice) => choice.id).join(", ")}`;
    }
    if (!problem) continue;
    if (entry.source === "explicit") throw new CliError(problem);
    selection.options.delete(id);
    warnings.push(`${problem}; dropped the ${entry.source} value`);
  }
  return warnings;
}

function toModelSelection(selection: { instanceId: string; model: string; options: Map<string, OptionEntry> }): ModelSelection {
  const options = [...selection.options].map(([id, entry]) => ({ id, value: entry.value }));
  return options.length > 0
    ? { instanceId: selection.instanceId, model: selection.model, options }
    : { instanceId: selection.instanceId, model: selection.model };
}

async function loadProvidersForValidation(flags: Flags): Promise<ProviderInstance[] | undefined> {
  if (flags["no-validate"]) return undefined;
  try {
    return await getProviders();
  } catch (error) {
    if (flags["dry-run"]) {
      console.error(`warning: skipped model validation (${errorMessage(error).split("\n")[0]})`);
      return undefined;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Project resolution
// ---------------------------------------------------------------------------

function gitMainRoot(cwd: string): string | undefined {
  try {
    const commonDir = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return commonDir.endsWith("/.git") ? commonDir.slice(0, -"/.git".length) : resolve(commonDir, "..");
  } catch {
    return undefined;
  }
}

async function resolveProject(flags: Flags, snapshot?: ShellSnapshot): Promise<{ projectId: string; projectCwd?: string }> {
  const projectId = stringFlag(flags, "project-id");
  const projectCwd = stringFlag(flags, "project-cwd");
  if (projectId && projectCwd) return { projectId, projectCwd };
  if (flags["dry-run"] && projectId) return { projectId, projectCwd };
  const state = snapshot ?? await getShellSnapshot();
  if (projectId) {
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new CliError(`Unknown project ${projectId}. Run \`t3ctl projects\`.`);
    return { projectId, projectCwd: projectCwd ?? project.workspaceRoot };
  }
  const root = gitMainRoot(projectCwd ?? process.cwd());
  const project = root ? state.projects.find((candidate) => candidate.workspaceRoot === root) : undefined;
  if (!project) {
    throw new CliError(`No T3 project matches ${root ?? process.cwd()}. Pass --project-id (see \`t3ctl projects\`).`, 2);
  }
  return { projectId: project.id, projectCwd: projectCwd ?? project.workspaceRoot };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function validateWorktreeName(name: string): void {
  if (!worktreeNamePattern.test(name)) {
    throw new CliError(`Invalid worktree name '${name}'. Use lower-kebab text that matches ${worktreeNamePattern}.`, 2);
  }
}

function normalizeDescription(description: string): string {
  const normalized = description.trim().replace(/\.$/, "");
  if (!normalized) usage("--description cannot be empty");
  return normalized;
}

function parseNullablePath(value: string | boolean | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return !normalized || normalized === "null" ? null : normalized;
}

async function readPrompt(flags: Flags): Promise<string> {
  const inline = stringFlag(flags, "prompt");
  const file = stringFlag(flags, "prompt-file");
  if (inline && file) usage("Use --prompt or --prompt-file, not both");
  const prompt = inline ?? (file ? (await readFile(file, "utf8")).trim() : undefined);
  if (!prompt) usage("Missing required --prompt or --prompt-file");
  return prompt;
}

async function createThreadCommand(flags: Flags, shared: boolean): Promise<void> {
  const branchFlag = stringFlag(flags, "branch");
  const worktreeName = stringFlag(flags, "worktree-name") ?? (branchFlag ? branchFlag.replace(/\//g, "-") : undefined);
  if (!worktreeName) usage("Missing required --worktree-name");
  validateWorktreeName(worktreeName);
  const branch = branchFlag ?? worktreeName;
  const description = normalizeDescription(requireFlag(flags, "description"));
  const prompt = await readPrompt(flags);
  const interactionMode = interactionModeFlag(flags) ?? "default";
  const runtimeMode = stringFlag(flags, "runtime-mode") ?? "full-access";

  const providers = await loadProvidersForValidation(flags);
  const selection = resolveNewSelection(flags, providers);
  if (providers) for (const warning of validateSelection(selection, providers)) console.error(`warning: ${warning}`);
  const modelSelection = toModelSelection(selection);

  const project = await resolveProject(flags);
  if (!shared && !project.projectCwd) usage("Missing --project-cwd and the project has no workspaceRoot");

  const threadId = randomUUID();
  const createdAt = now();
  const title = `${worktreeName}: ${description}`;
  const createThread = {
    projectId: project.projectId,
    title,
    modelSelection,
    runtimeMode,
    interactionMode,
    branch: shared ? branch : null,
    worktreePath: shared ? parseNullablePath(flags["worktree-path"]) : null,
    createdAt,
  };
  const bootstrap: Record<string, JsonValue> = {
    createThread: createThread as unknown as JsonValue,
    runSetupScript: booleanFlag(flags, "run-setup-script") ?? false,
  };
  if (!shared) {
    bootstrap.prepareWorktree = {
      projectCwd: project.projectCwd!,
      baseBranch: stringFlag(flags, "base-branch") ?? "main",
      branch,
      ...(flags["start-from-origin"] ? { startFromOrigin: true } : {}),
    };
  }
  const payload = {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text: prompt, attachments: [] },
    modelSelection,
    titleSeed: title,
    runtimeMode,
    interactionMode,
    bootstrap,
    createdAt,
  } as unknown as JsonValue;
  if (flags["dry-run"]) {
    printJson(payload);
    return;
  }
  const result = await dispatch(payload);
  printJson({ threadId, title, branch, worktreePath: createThread.worktreePath, modelSelection, rpcResult: result });
}

async function sendCommand(flags: Flags, positional: string[]): Promise<void> {
  const [threadId, text, legacyMode] = positional;
  if (!threadId || !text) usage("send needs <thread-id> <message>");
  const snapshot = await getShellSnapshot();
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
  if (!thread) throw new CliError(`Unknown thread ${threadId}`);
  const interactionMode = interactionModeFlag(flags) ?? legacyMode ?? thread.interactionMode ?? "default";
  if (!interactionModes.has(interactionMode)) usage(`interaction mode must be one of: ${[...interactionModes].join(", ")}`);
  const payload: Record<string, JsonValue> = {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text, attachments: [] },
    runtimeMode: thread.runtimeMode ?? "full-access",
    interactionMode,
    createdAt: now(),
  };
  // Without model flags, omit modelSelection so the thread keeps its persisted selection.
  if (hasModelRequest(readModelRequest(flags))) {
    const providers = await loadProvidersForValidation(flags);
    const selection = resolveFollowUpSelection(flags, thread, providers);
    if (providers) for (const warning of validateSelection(selection, providers)) console.error(`warning: ${warning}`);
    payload.modelSelection = toModelSelection(selection) as unknown as JsonValue;
  }
  if (flags["dry-run"]) {
    printJson(payload);
    return;
  }
  printJson(await dispatch(payload));
}

function command(type: string, threadId: string, extra: Record<string, JsonValue> = {}, timestamp = false): JsonValue {
  return { type, commandId: randomUUID(), threadId, ...extra, ...(timestamp ? { createdAt: now() } : {}) };
}

function describeSelection(selection?: ModelSelection | null): string {
  if (!selection) return "";
  const options = (selection.options ?? []).map((option) => `${option.id}=${String(option.value)}`).join(",");
  return `${selection.instanceId}/${selection.model}${options ? ` [${options}]` : ""}`;
}

async function doctorCommand(flags: Flags): Promise<void> {
  const checks: Record<string, JsonValue> = {};
  let status = "ok";
  const auth = getAuth();
  checks.authentication = auth.mode === "none"
    ? { status: "error", message: auth.error ?? "unknown" }
    : { status: "ok", mode: auth.mode };
  if (auth.mode === "none") status = "degraded";
  try {
    const config = await rpc("server.getConfig", {});
    const providers: ProviderInstance[] = config?.providers ?? [];
    checks.server = {
      status: "ok",
      version: config?.environment?.serverVersion ?? null,
      readyInstances: providers.filter((p) => p.enabled && p.status === "ready").map((p) => p.instanceId),
    };
  } catch (error) {
    status = "degraded";
    checks.server = { status: "error", message: errorMessage(error).split("\n")[0] };
  }
  try {
    const snapshot = await getShellSnapshot();
    checks.orchestration = {
      status: "ok",
      snapshotSequence: snapshot.snapshotSequence ?? null,
      projectCount: snapshot.projects.length,
      activeThreadCount: snapshot.threads.filter((t) => !t.deletedAt && !t.archivedAt).length,
      archivedThreadCount: snapshot.threads.filter((t) => !t.deletedAt && t.archivedAt).length,
    };
  } catch (error) {
    status = "degraded";
    checks.orchestration = { status: "error", message: errorMessage(error).split("\n")[0] };
  }
  if (authState && authState.mode !== "none") checks.authentication = { status: "ok", mode: authState.mode };
  const detected = detectHarness(flags);
  checks.harness = { harness: detected.harness ?? null, source: detected.source };
  printJson({ status, baseUrl, webSocketUrl: wsUrl, cookieDb, checks });
  if (status !== "ok") process.exitCode = 1;
}

async function harnessCommand(flags: Flags): Promise<void> {
  const detected = detectHarness(flags);
  let selection: ModelSelection | null = null;
  let error: string | null = null;
  try {
    selection = toModelSelection(resolveNewSelection(flags));
  } catch (caught) {
    error = errorMessage(caught);
  }
  printJson({ harness: detected.harness ?? null, source: detected.source, defaultModelSelection: selection, error });
}

// Report the server snapshot without inferring credit availability from readiness.
// Source: T3 0.0.42 ServerProviderUsageLimits and server.refreshProviders schemas.
async function providersCommand(flags: Flags): Promise<void> {
  const instance = stringFlag(flags, "instance");
  let providers = await getProviders();
  if (instance && !providers.some((p) => p.instanceId === instance)) {
    throw new CliError(`Unknown provider instance ${instance}`);
  }
  if (booleanFlag(flags, "refresh")) {
    await rpc("server.refreshProviders", instance ? { instanceId: instance } : {});
    providers = await getProviders();
  }
  const rows = providers
    .filter((p) => instance ? p.instanceId === instance : booleanFlag(flags, "all") || p.enabled)
    .map((p) => ({
      instanceId: p.instanceId, driver: p.driver, displayName: p.displayName ?? null,
      enabled: p.enabled ?? null, status: p.status ?? "unknown",
      continuationGroup: p.continuation?.groupKey ?? null,
      usageLimits: p.usageLimits ?? null,
    }));
  if (flags.json) { printJson(rows); return; }
  for (const p of rows) {
    console.log(`${p.instanceId}\tdriver=${p.driver}\tstatus=${p.status}\tenabled=${p.enabled}`);
    const limits = p.usageLimits;
    if (!limits) { console.log("  usage=unknown (server supplied no limits)"); continue; }
    console.log(`  checkedAt=${limits.checkedAt}`);
    if (limits.unavailable) {
      console.log(`  usage=unavailable reason=${limits.unavailable.reason}${limits.unavailable.message ? ` message=${limits.unavailable.message}` : ""}`);
    }
    if (!limits.windows.length && !limits.unavailable) console.log("  usage=unknown (no reported windows)");
    for (const w of limits.windows) {
      const used = typeof w.usedPercent === "number" ? `${w.usedPercent}%` : "unknown";
      console.log(`  ${w.id}\tused=${used}\treset=${w.resetsAt ?? "unknown"}\twindowMins=${w.windowDurationMins ?? "unknown"}`);
    }
    if (limits.resetCredits) console.log(`  resetCredits=${limits.resetCredits.availableCount}\tnextExpiry=${limits.resetCredits.nextExpiresAt ?? "unknown"}`);
  }
}

async function modelsCommand(flags: Flags): Promise<void> {
  const instanceFilter = stringFlag(flags, "instance");
  const providers = (await getProviders()).filter((p) => !instanceFilter || p.instanceId === instanceFilter);
  if (flags.json) {
    printJson(providers.map((p) => ({
      instanceId: p.instanceId, driver: p.driver, displayName: p.displayName ?? null, enabled: p.enabled, status: p.status,
      models: (p.models ?? []).map((m) => ({
        slug: m.slug,
        options: (m.capabilities?.optionDescriptors ?? []).map((d) => ({
          id: d.id, type: d.type, values: d.options?.map((o) => o.id) ?? null,
          default: d.options?.find((o) => o.isDefault)?.id ?? null,
        })),
      })),
    })));
    return;
  }
  for (const provider of providers) {
    if (!provider.enabled && !instanceFilter) continue;
    console.log(`${provider.instanceId}\tdriver=${provider.driver}\tstatus=${provider.status}${provider.displayName ? `\t${provider.displayName}` : ""}`);
    for (const model of provider.models ?? []) {
      const options = (model.capabilities?.optionDescriptors ?? []).map((d) =>
        d.options ? `${d.id}=${d.options.map((o) => (o.isDefault ? `${o.id}*` : o.id)).join("|")}` : `${d.id}:${d.type}`);
      console.log(`  ${model.slug}\t${options.join("  ")}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Listing, lookup and history
// ---------------------------------------------------------------------------

type ThreadState = "archived" | "attention" | "error" | "running" | "working" | "monitoring" | "idle" | "new";

// Follows the T3 sidebar order (apps/web/src/components/Sidebar.logic.ts): attention, failed
// session, active turn, then background liveness. After a turn ends, background agents
// (subagents, workflows) make the thread "working". Watch loops (Monitor tasks, background
// shells) alone make it "monitoring".
function threadState(thread: ThreadLike): ThreadState {
  if (thread.archivedAt) return "archived";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention";
  if (thread.session?.status === "error") return "error";
  const turnState = thread.latestTurn?.state ?? thread.latestTurn?.status;
  if (turnState === "running" || thread.session?.status === "starting") return "running";
  if (turnState === "error") return "error";
  if (thread.backgroundLiveness === "working") return "working";
  if (thread.backgroundLiveness === "monitoring") return "monitoring";
  return thread.latestTurn ? "idle" : "new";
}

const busyStates: ReadonlySet<ThreadState> = new Set(["running", "working", "monitoring"]);

function harnessOf(selection?: ModelSelection | null): string {
  const instance = selection?.instanceId ?? "";
  if (instance.startsWith("claude")) return "claude";
  if (instance.startsWith("codex")) return "codex";
  return instance || "unknown";
}

function isPathRef(ref: string): boolean {
  return ref.startsWith("/") || ref.startsWith(".") || ref.startsWith("~");
}

function normalizePath(path: string): string {
  const expanded = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
  try {
    return realpathSync(resolve(expanded));
  } catch {
    return resolve(expanded);
  }
}

function newestFirst(a: ThreadLike, b: ThreadLike): number {
  return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
}

// Resolve a thread ID or a worktree path to one thread. For a path, prefer an unarchived
// thread and then the thread that changed last. Report the other candidates on stderr.
function resolveThreadRef(ref: string, snapshot: ShellSnapshot, flags: Flags = {}): ThreadLike {
  if (!isPathRef(ref)) {
    const thread = snapshot.threads.find((t) => t.id === ref);
    if (!thread) throw new CliError(`Unknown thread ${ref}`);
    return thread;
  }
  const path = normalizePath(ref);
  let candidates = snapshot.threads.filter((t) => !t.deletedAt && t.worktreePath && normalizePath(t.worktreePath) === path);
  if (candidates.length === 0) {
    const project = snapshot.projects.find((p) => p.workspaceRoot && normalizePath(p.workspaceRoot) === path);
    if (project) candidates = snapshot.threads.filter((t) => !t.deletedAt && t.projectId === project.id && !t.worktreePath);
  }
  if (!flags.all) {
    const active = candidates.filter((t) => !t.archivedAt);
    if (active.length > 0) candidates = active;
  }
  candidates.sort(newestFirst);
  if (candidates.length === 0) throw new CliError(`No thread is bound to ${path}. Run \`t3ctl threads --worktree ${path} --all\`.`);
  if (candidates.length > 1) {
    console.error(`warning: ${candidates.length} threads use ${path}. Selected the newest: ${candidates[0].id} (${candidates[0].title}).`);
    for (const other of candidates.slice(1, 6)) console.error(`  other: ${other.id}\t${threadState(other)}\t${other.updatedAt}\t${other.title}`);
  }
  return candidates[0];
}

function matchProject(project: ProjectLike, query: string): boolean {
  if (project.id === query) return true;
  if (isPathRef(query)) return Boolean(project.workspaceRoot) && normalizePath(project.workspaceRoot!) === normalizePath(query);
  const needle = query.toLowerCase();
  return (project.title ?? "").toLowerCase().includes(needle) || (project.workspaceRoot ?? "").toLowerCase().includes(needle);
}

function csvSet(value: string | undefined): Set<string> | undefined {
  return value ? new Set(value.split(",").map((part) => part.trim()).filter(Boolean)) : undefined;
}

function limitFlag(flags: Flags, fallback?: number): number | undefined {
  const raw = stringFlag(flags, "limit");
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) usage(`--limit expects a positive integer, got ${raw}`);
  return value;
}

async function projectsCommand(flags: Flags): Promise<void> {
  const snapshot = await getShellSnapshot();
  const query = stringFlag(flags, "search") ?? stringFlag(flags, "project");
  const rows = snapshot.projects
    .filter((p) => !p.deletedAt)
    .filter((p) => !query || matchProject(p, query))
    .map((p) => {
      const threads = snapshot.threads.filter((t) => t.projectId === p.id && !t.deletedAt);
      const active = threads.filter((t) => !t.archivedAt);
      const lastActivity = threads.map((t) => t.updatedAt ?? "").sort().at(-1) || p.updatedAt || null;
      return {
        id: p.id, title: p.title ?? null, workspaceRoot: p.workspaceRoot ?? null, lastActivity,
        activeThreads: active.length, runningThreads: active.filter((t) => threadState(t) === "running").length,
        attentionThreads: active.filter((t) => threadState(t) === "attention").length,
        backgroundThreads: active.filter((t) => ["working", "monitoring"].includes(threadState(t))).length,
        archivedThreads: threads.length - active.length,
      };
    })
    .filter((p) => !flags.active || p.activeThreads > 0)
    .sort((a, b) => String(b.lastActivity ?? "").localeCompare(String(a.lastActivity ?? "")));
  const limited = rows.slice(0, limitFlag(flags) ?? rows.length);
  if (flags.json) {
    printJson(limited);
    return;
  }
  console.log("lastActivity\tactive\trunning\tbackground\tattention\tid\ttitle\tworkspaceRoot");
  for (const p of limited) {
    console.log([p.lastActivity ?? "", p.activeThreads, p.runningThreads, p.backgroundThreads, p.attentionThreads, p.id, p.title ?? "", p.workspaceRoot ?? ""].join("\t"));
  }
}

async function threadsCommand(flags: Flags): Promise<void> {
  const snapshot = await getShellSnapshot();
  const projectQuery = stringFlag(flags, "project", "project-id");
  const projectIds = projectQuery ? new Set(snapshot.projects.filter((p) => matchProject(p, projectQuery)).map((p) => p.id)) : undefined;
  if (projectIds && projectIds.size === 0) throw new CliError(`No project matches ${projectQuery}. Run \`t3ctl projects\`.`);
  const states = csvSet(stringFlag(flags, "state"));
  const harnesses = csvSet(stringFlag(flags, "harness"));
  const instances = csvSet(stringFlag(flags, "instance", "model-instance"));
  const models = csvSet(stringFlag(flags, "model"));
  const branch = stringFlag(flags, "branch");
  const worktree = stringFlag(flags, "worktree");
  const search = stringFlag(flags, "search")?.toLowerCase();
  const since = stringFlag(flags, "since");
  const sinceIso = since ? new Date(Date.now() - parseDuration(since, 0)).toISOString() : undefined;
  const includeArchived = Boolean(flags.all || flags.archived || states?.has("archived"));
  const sortKey = stringFlag(flags, "sort") ?? "updated";
  const sortField: Record<string, (t: ThreadLike) => string> = {
    updated: (t) => t.updatedAt ?? "",
    created: (t) => t.createdAt ?? "",
    message: (t) => t.latestUserMessageAt ?? "",
    title: (t) => t.title ?? "",
  };
  if (!sortField[sortKey]) usage(`--sort must be one of: ${Object.keys(sortField).join(", ")}`);
  const projectTitle = new Map(snapshot.projects.map((p) => [p.id, p.title ?? p.id]));
  const threads = snapshot.threads
    .filter((t) => !t.deletedAt)
    .filter((t) => includeArchived || !t.archivedAt)
    .filter((t) => !flags.archived || Boolean(t.archivedAt))
    .filter((t) => !projectIds || projectIds.has(t.projectId ?? ""))
    .filter((t) => !states || states.has(threadState(t)))
    .filter((t) => !harnesses || harnesses.has(harnessOf(t.modelSelection)))
    .filter((t) => !instances || instances.has(t.modelSelection?.instanceId ?? ""))
    .filter((t) => !models || models.has(t.modelSelection?.model ?? ""))
    .filter((t) => !branch || (t.branch ?? "").includes(branch))
    .filter((t) => !worktree || (Boolean(t.worktreePath) && normalizePath(t.worktreePath!) === normalizePath(worktree)))
    .filter((t) => !search || (t.title ?? "").toLowerCase().includes(search))
    .filter((t) => !sinceIso || (t.updatedAt ?? "") >= sinceIso)
    .sort((a, b) => {
      const order = sortField[sortKey](a).localeCompare(sortField[sortKey](b));
      return sortKey === "title" ? (flags.reverse ? -order : order) : (flags.reverse ? order : -order);
    });
  const limited = threads.slice(0, limitFlag(flags) ?? threads.length);
  if (flags.json) {
    printJson(limited.map((t) => ({
      id: t.id, title: t.title, projectId: t.projectId, project: projectTitle.get(t.projectId ?? "") ?? null,
      state: threadState(t), harness: harnessOf(t.modelSelection), modelSelection: t.modelSelection ?? null,
      branch: t.branch ?? null, worktreePath: t.worktreePath ?? null, interactionMode: t.interactionMode, runtimeMode: t.runtimeMode,
      sessionStatus: t.session?.status ?? null, latestTurnState: t.latestTurn?.state ?? t.latestTurn?.status ?? null,
      backgroundLiveness: t.backgroundLiveness ?? null, createdAt: t.createdAt ?? null, updatedAt: t.updatedAt ?? null, latestUserMessageAt: t.latestUserMessageAt ?? null,
      archivedAt: t.archivedAt ?? null,
    })));
    return;
  }
  console.log("updatedAt\tstate\tmodel\tproject\ttitle\tid\tbranch\tworktreePath");
  for (const t of limited) {
    console.log([
      t.updatedAt ?? "", threadState(t), t.modelSelection ? `${t.modelSelection.instanceId}/${t.modelSelection.model}` : "",
      projectTitle.get(t.projectId ?? "") ?? "", t.title ?? "", t.id ?? "", t.branch ?? "", t.worktreePath ?? "",
    ].join("\t"));
  }
}

interface ThreadDetail {
  thread: ThreadLike & {
    messages?: Array<{ id: string; role: string; text?: string; createdAt: string; turnId?: string | null; streaming?: boolean }>;
    activities?: Array<{ kind: string; summary: string; tone?: string; createdAt: string; turnId?: string | null }>;
    proposedPlans?: Array<{ planMarkdown: string; createdAt: string; implementedAt?: string | null }>;
  };
  page?: { beforeCursor: string | null; hasMore: boolean };
}

async function getThreadDetail(threadId: string, turnLimit?: number, beforeCursor?: string): Promise<ThreadDetail> {
  const query = new URLSearchParams();
  if (turnLimit) query.set("turnLimit", String(turnLimit));
  if (beforeCursor) query.set("beforeCursor", beforeCursor);
  const suffix = query.size > 0 ? `?${query}` : "";
  return await requestJson(`/api/orchestration/threads/${encodeURIComponent(threadId)}${suffix}`);
}

// Read history. `--turns N` reads the last N user turns. `--before <cursor>` reads the
// next older page. `--all` reads the full thread in one request.
async function loadHistory(threadId: string, flags: Flags): Promise<ThreadDetail> {
  if (flags.all) return await getThreadDetail(threadId);
  const turns = Number(stringFlag(flags, "turns") ?? "10");
  if (!Number.isInteger(turns) || turns <= 0) usage("--turns expects a positive integer");
  return await getThreadDetail(threadId, turns, stringFlag(flags, "before"));
}

function renderTranscript(detail: ThreadDetail, flags: Flags): string {
  const t = detail.thread;
  const maxChars = Number(stringFlag(flags, "max-chars") ?? "0");
  const clip = (text: string) => (maxChars > 0 && text.length > maxChars ? `${text.slice(0, maxChars)}\n[... ${text.length - maxChars} more characters]` : text);
  const entries: Array<{ at: string; block: string }> = [];
  for (const message of t.messages ?? []) {
    if (flags["user-only"] && message.role !== "user") continue;
    entries.push({ at: message.createdAt, block: `### ${message.role} · ${message.createdAt}\n\n${clip((message.text ?? "").trim())}` });
  }
  if (flags.activities) {
    const everyKind = flags.activities === "all";
    for (const activity of t.activities ?? []) {
      if (activity.kind === "context-window.updated") continue;
      if (!everyKind && activity.tone !== "error" && !activity.kind.includes("error")) continue;
      entries.push({ at: activity.createdAt, block: `- activity · ${activity.createdAt} · ${activity.kind}: ${activity.summary}` });
    }
  }
  for (const plan of t.proposedPlans ?? []) {
    entries.push({ at: plan.createdAt, block: `### proposed plan · ${plan.createdAt}${plan.implementedAt ? " (implemented)" : ""}\n\n${clip(plan.planMarkdown)}` });
  }
  entries.sort((a, b) => a.at.localeCompare(b.at));
  const header = [
    `# ${t.title ?? t.id}`,
    "",
    `- thread: ${t.id}`,
    `- model: ${describeSelection(t.modelSelection)}`,
    `- branch: ${t.branch ?? ""}`,
    `- worktree: ${t.worktreePath ?? "(project root)"}`,
    `- state: ${threadState(t)} · updated ${t.updatedAt ?? ""}`,
    `- page: ${detail.page ? `hasMore=${detail.page.hasMore}${detail.page.beforeCursor ? ` next=--before ${detail.page.beforeCursor}` : ""}` : "full thread"}`,
  ].join("\n");
  return `${header}\n\n${entries.map((entry) => entry.block).join("\n\n")}\n`;
}

async function historyCommand(flags: Flags, positional: string[]): Promise<void> {
  const [ref] = positional;
  if (!ref) usage("history needs <thread-id | worktree-path>");
  const thread = resolveThreadRef(ref, await getShellSnapshot(), flags);
  const detail = await loadHistory(thread.id!, flags);
  const output = flags.json ? JSON.stringify(detail, null, 2) : renderTranscript(detail, flags);
  const out = stringFlag(flags, "out");
  if (out) {
    await writeFile(out, output);
    console.error(`wrote ${out}`);
  } else {
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  }
  if (detail.page?.hasMore) console.error(`older turns exist: t3ctl history ${thread.id} --before ${detail.page.beforeCursor}`);
}

async function searchCommand(flags: Flags, positional: string[]): Promise<void> {
  const query = positional.join(" ").trim();
  if (query.length < 2) usage("search needs a query of 2 or more characters");
  const result = await rpc("orchestration.searchThreads", { query, limit: limitFlag(flags, 20)! });
  const snapshot = await getShellSnapshot();
  const byId = new Map(snapshot.threads.map((t) => [t.id, t]));
  const matches = (result?.matches ?? []).map((m: any) => ({ ...m, title: byId.get(m.threadId)?.title ?? null, state: byId.get(m.threadId) ? threadState(byId.get(m.threadId)!) : null }));
  if (flags.json) {
    printJson(matches);
    return;
  }
  for (const m of matches) console.log(`${m.messageCreatedAt ?? ""}\t${m.threadId}\t${m.source}\t${m.title ?? ""}\t${String(m.snippet).replace(/\s+/g, " ")}`);
}

function gitText(cwd: string, args: string[], maxLines = 60): string {
  try {
    const lines = execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 }).trim().split("\n");
    return lines.length > maxLines ? [...lines.slice(0, maxLines), `[... ${lines.length - maxLines} more lines]`].join("\n") : lines.join("\n");
  } catch (error) {
    return `(git ${args[0]} failed: ${errorMessage(error).split("\n")[0]})`;
  }
}

// List processes whose working directory is inside `root` (Linux /proc only). Long jobs
// that outlive a turn, such as studies or services, are part of the handoff state.
function processesUnder(root: string): Array<{ pid: number; cwd: string; command: string }> {
  if (!existsSync("/proc")) return [];
  const prefix = normalizePath(root);
  const rows: Array<{ pid: number; cwd: string; command: string }> = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cwd = readlinkSync(`/proc/${entry}/cwd`);
      if (cwd !== prefix && !cwd.startsWith(`${prefix}/`)) continue;
      const raw = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      const redacted = raw.replace(/(bearer\s+|token["'=:\s]+|authorization["'=:\s]+|api[_-]?key["'=:\s]+|secret["'=:\s]+)\S+/gi, "$1[redacted]");
      rows.push({ pid: Number(entry), cwd, command: redacted.length > 300 ? `${redacted.slice(0, 300)}...` : redacted });
    } catch {
      // The process ended or belongs to another user.
    }
  }
  return rows.sort((a, b) => a.pid - b.pid);
}

// Write a handoff bundle for one thread: metadata, transcript and git state of its
// checkout. An agent (or subagent) reads the bundle and writes the continuation brief.
async function handoffCommand(flags: Flags, positional: string[]): Promise<void> {
  const [ref] = positional;
  if (!ref) usage("handoff needs <thread-id | worktree-path>");
  const snapshot = await getShellSnapshot();
  const thread = resolveThreadRef(ref, snapshot, flags);
  const project = snapshot.projects.find((p) => p.id === thread.projectId);
  const checkout = thread.worktreePath ?? project?.workspaceRoot;
  const stamp = now().replace(/[:.]/g, "-");
  const outDir = stringFlag(flags, "out")
    ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "t3ctl", "handoffs", `${thread.id}-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  const recent = await getThreadDetail(thread.id!, Number(stringFlag(flags, "turns") ?? "8"));
  const full = await getThreadDetail(thread.id!);
  await writeFile(join(outDir, "thread.json"), JSON.stringify({ ...thread, state: threadState(thread), project: project?.title ?? null }, null, 2));
  await writeFile(join(outDir, "transcript-recent.md"), renderTranscript(recent, { activities: true, "max-chars": "6000" }));
  await writeFile(join(outDir, "transcript-full.md"), renderTranscript(full, {}));

  const baseBranch = stringFlag(flags, "base-branch") ?? "main";
  if (checkout && existsSync(checkout)) {
    const git = [
      `# Git state of ${checkout}`,
      "", "## Branch and HEAD", "", "```", gitText(checkout, ["status", "--short", "--branch"]), "```",
      "", `## Commits not in ${baseBranch}`, "", "```", gitText(checkout, ["log", "--oneline", "-40", `${baseBranch}..HEAD`]), "```",
      "", `## Diff stat against ${baseBranch}`, "", "```", gitText(checkout, ["diff", "--stat", `${baseBranch}...HEAD`]), "```",
      "", "## Uncommitted diff stat", "", "```", gitText(checkout, ["diff", "--stat", "HEAD"]), "```",
    ].join("\n");
    await writeFile(join(outDir, "git.md"), `${git}\n`);
  }
  const processes = checkout ? processesUnder(checkout) : [];
  if (processes.length > 0) {
    await writeFile(join(outDir, "processes.md"), [
      `# Processes with a working directory under ${checkout}`,
      "",
      "Command lines are shortened and token-like values are redacted.",
      "",
      ...processes.map((p) => `- pid ${p.pid} · cwd ${p.cwd}\n  \`${p.command}\``),
      "",
    ].join("\n"));
  }
  const fullMessages = full.thread.messages ?? [];
  printJson({
    processes: processes.length,
    outDir,
    thread: { id: thread.id, title: thread.title, state: threadState(thread), modelSelection: thread.modelSelection, branch: thread.branch, worktreePath: thread.worktreePath },
    files: ["thread.json", "transcript-recent.md", "transcript-full.md", ...(checkout && existsSync(checkout) ? ["git.md"] : []), ...(processes.length > 0 ? ["processes.md"] : [])],
    messages: fullMessages.length,
    userMessages: fullMessages.filter((m) => m.role === "user").length,
    transcriptChars: fullMessages.reduce((sum, m) => sum + (m.text?.length ?? 0), 0),
  });
}

// Start a new thread in the same checkout and branch as an existing thread. By default the
// new thread uses the caller's harness, so a Claude agent can continue a Codex thread.
async function continueThreadCommand(flags: Flags, positional: string[]): Promise<void> {
  const [ref] = positional;
  if (!ref) usage("continue-thread needs <thread-id | worktree-path>");
  const snapshot = await getShellSnapshot();
  const source = resolveThreadRef(ref, snapshot, flags);
  const sourceState = threadState(source);
  if (busyStates.has(sourceState) && !booleanFlag(flags, "allow-running")) {
    throw new CliError(`Source thread ${source.id} is ${sourceState}. Wait with \`t3ctl wait ${source.id} --until-quiet\`, or pass --allow-running.`);
  }
  const worktreeName = stringFlag(flags, "worktree-name")
    ?? (source.worktreePath ? basename(source.worktreePath) : (source.branch ?? "main").replace(/\//g, "-"));
  const sourceDescription = (source.title ?? "").includes(": ") ? source.title!.slice(source.title!.indexOf(": ") + 2) : (source.title ?? "Continue work");
  const merged: Flags = {
    ...flags,
    "project-id": source.projectId!,
    "worktree-name": worktreeName,
    ...(source.branch ? { branch: source.branch } : {}),
    "worktree-path": source.worktreePath ?? "null",
    description: stringFlag(flags, "description") ?? `${sourceDescription.replace(/ \(continued\)$/, "")} (continued)`,
  };
  await createThreadCommand(merged, true);
  if (!flags["dry-run"]) {
    console.error(`note: source thread ${source.id} is unchanged. Archive it after the user confirms: t3ctl archive ${source.id}`);
  }
}

function parseDuration(raw: string | undefined, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const match = /^(\d+)(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) usage(`Invalid duration ${raw}. Use for example 90s, 15m or 2h.`);
  const unit = { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] ?? "s"]!;
  return Number(match[1]) * unit;
}

// Poll one thread until it stops working. By default, stop at "monitoring": the turn and all
// background agents ended, and only watch loops run, which can last for hours. With
// --until-quiet, also wait for the watch loops to end.
async function waitCommand(flags: Flags, positional: string[]): Promise<void> {
  const [threadId] = positional;
  if (!threadId) usage("wait needs <thread-id>");
  const timeoutMs = parseDuration(stringFlag(flags, "timeout"), 30 * 60000);
  const intervalMs = parseDuration(stringFlag(flags, "interval"), 15000);
  const waitStates = new Set<ThreadState>(flags["until-quiet"] ? ["running", "working", "monitoring"] : ["running", "working"]);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const thread = (await getShellSnapshot()).threads.find((t) => t.id === threadId);
    if (!thread) throw new CliError(`Unknown thread ${threadId}`);
    const state = threadState(thread);
    const timedOut = Date.now() >= deadline;
    if (!waitStates.has(state) || timedOut) {
      const reason = timedOut && waitStates.has(state) ? "timeout" : state === "attention" ? "needs-attention" : state;
      printJson({
        threadId, reason, state, turnState: thread.latestTurn?.state ?? thread.latestTurn?.status ?? null,
        sessionStatus: thread.session?.status ?? null, backgroundLiveness: thread.backgroundLiveness ?? null,
        hasPendingApprovals: Boolean(thread.hasPendingApprovals), hasPendingUserInput: Boolean(thread.hasPendingUserInput),
      });
      if (reason === "timeout") process.exitCode = 3;
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
}

async function main(argv: string[]): Promise<void> {
  const [subcommand, ...args] = argv;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    console.log(usageText);
    return;
  }
  const { flags, positional } = parseFlags(args);

  switch (subcommand) {
    case "uuid":
      console.log(randomUUID());
      return;
    case "doctor":
      return await doctorCommand(flags);
    case "harness":
      return await harnessCommand(flags);
    case "providers":
      return await providersCommand(flags);
    case "models":
      return await modelsCommand(flags);
    case "snapshot":
      printJson(await getShellSnapshot());
      return;
    case "projects":
      return await projectsCommand(flags);
    case "threads":
      return await threadsCommand(flags);
    case "thread": {
      const [ref] = positional;
      if (!ref) usage("thread needs <thread-id | worktree-path>");
      const thread = resolveThreadRef(ref, await getShellSnapshot(), flags);
      printJson({ ...thread, state: threadState(thread) });
      return;
    }
    case "history":
      return await historyCommand(flags, positional);
    case "search":
      return await searchCommand(flags, positional);
    case "handoff":
      return await handoffCommand(flags, positional);
    case "continue-thread":
      return await continueThreadCommand(flags, positional);
    case "wait":
      return await waitCommand(flags, positional);
    case "rpc": {
      const [method, payloadArg] = positional;
      if (!method) usage("rpc needs <method>");
      printJson(await rpc(method, await parseJsonArg(payloadArg)));
      return;
    }
    case "dispatch": {
      const [file] = positional;
      if (!file) usage("dispatch needs <command-json-file>");
      printJson(await dispatch(await parseJsonArg(file)));
      return;
    }
    case "create-thread":
      return await createThreadCommand(flags, false);
    case "create-shared-thread":
      return await createThreadCommand(flags, true);
    case "send":
      return await sendCommand(flags, positional);
    case "interrupt": {
      const [threadId, turnId] = positional;
      if (!threadId) usage("interrupt needs <thread-id>");
      printJson(await dispatch(command("thread.turn.interrupt", threadId, turnId ? { turnId } : {}, true)));
      return;
    }
    case "stop": {
      const [threadId] = positional;
      if (!threadId) usage("stop needs <thread-id>");
      printJson(await dispatch(command("thread.session.stop", threadId, {}, true)));
      return;
    }
    case "archive":
    case "unarchive":
    case "delete": {
      const [threadId] = positional;
      if (!threadId) usage(`${subcommand} needs <thread-id>`);
      printJson(await dispatch(command(`thread.${subcommand}`, threadId)));
      return;
    }
    case "remove-worktree": {
      const payload = {
        cwd: requireFlag(flags, "project-cwd"),
        path: requireFlag(flags, "worktree-path"),
        ...(booleanFlag(flags, "force") ? { force: true } : {}),
      };
      if (flags["dry-run"]) printJson(payload);
      else printJson(await rpc("vcs.removeWorktree", payload));
      return;
    }
    case "set-mode": {
      const [threadId] = positional;
      if (!threadId) usage("set-mode needs <thread-id>");
      const commands: JsonValue[] = [];
      const runtimeMode = stringFlag(flags, "runtime-mode");
      const interactionMode = interactionModeFlag(flags);
      if (runtimeMode) commands.push(command("thread.runtime-mode.set", threadId, { runtimeMode }, true));
      if (interactionMode) commands.push(command("thread.interaction-mode.set", threadId, { interactionMode }, true));
      if (commands.length === 0) usage("set-mode needs --interaction-mode and/or --runtime-mode");
      const results = [];
      for (const item of commands) results.push(await dispatch(item));
      printJson(results.length === 1 ? results[0] : results);
      return;
    }
    case "approve": {
      const [threadId, requestId, decision] = positional;
      if (!threadId || !requestId || !decision) usage("approve needs <thread-id> <request-id> <decision>");
      if (!approvalDecisions.has(decision)) usage(`decision must be one of: ${[...approvalDecisions].join(", ")}`);
      printJson(await dispatch(command("thread.approval.respond", threadId, { requestId, decision }, true)));
      return;
    }
    case "answer": {
      const [threadId, requestId, answersArg] = positional;
      if (!threadId || !requestId || !answersArg) usage("answer needs <thread-id> <request-id> <answers-json-or-file>");
      printJson(await dispatch(command("thread.user-input.respond", threadId, { requestId, answers: await parseJsonArg(answersArg) }, true)));
      return;
    }
    default:
      usage(`Unknown command: ${subcommand}`);
  }
}

main(process.argv.slice(2))
  .catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  })
  .finally(revokeAutoSession);
