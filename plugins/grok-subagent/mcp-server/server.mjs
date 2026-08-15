#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const VERSION = "0.6.0";
const MAX_AGENTS = 3;
const MAX_RETAINED_FAILED_AGENTS = 3;
const MAX_TEXT = 120_000;
const MAX_STDERR = 12_000;
const CANCEL_TIMEOUT_MS = 10_000;
const ACTIVE_STATUSES = new Set(["running", "cancelling", "awaiting_plan_approval"]);
const DEFAULT_SLASH_COMMANDS = ["compact", "context", "session-info", "view-plan", "tasks", "queue"];
const HARD_BLOCKED_SLASH_COMMANDS = new Set([
  "always-approve", "auto", "config", "settings", "login", "logout", "privacy", "share", "export",
  "hooks-trust", "hooks-add", "hooks-remove", "hooks-untrust", "plugins", "marketplace", "remember",
  "memory", "import-claude", "create-skill", "create-workflow", "goal", "loop"
]);
const PLUGIN_CONFIG_KEYS = new Set([
  "default_model", "default_reasoning_effort", "default_session_mode", "default_agent_profile",
  "default_subagents_enabled", "allowed_slash_commands"
]);
const DEFAULT_PLUGIN_CONFIG = Object.freeze({
  schema_version: 1,
  default_model: null,
  default_reasoning_effort: null,
  default_session_mode: "agent",
  default_agent_profile: null,
  default_subagents_enabled: false,
  allowed_slash_commands: DEFAULT_SLASH_COMMANDS
});
const SUPPORTED_MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const CHILD_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "all_proxy", "no_proxy",
  "__CF_USER_TEXT_ENCODING", "XAI_API_KEY"
];
const agents = new Map();

const TOOL_DEFINITIONS = [
  {
    name: "grok_spawn_readonly",
    description: "Start an authenticated Grok Build agent in an OS-enforced read-only sandbox. Returns immediately after ACP setup while the prompt runs in the background.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Bounded task and expected output." },
        cwd: { type: "string", description: "Absolute project directory Grok may inspect." },
        role: { type: "string", description: "Short specialist role, such as reviewer or investigator." },
        model: { type: "string", description: "Optional Grok Build model ID. Explicit input overrides plugin and Grok defaults." },
        reasoning_effort: { type: "string", description: "Optional reasoning effort supported by the selected model, such as low, medium, high, or xhigh." },
        session_mode: { type: "string", enum: ["agent", "plan"], description: "Start in normal agent mode or read-only plan mode." },
        agent_profile: { type: "string", description: "Optional named Grok agent profile discovered by grok inspect." },
        subagents_enabled: { type: "boolean", description: "Allow Grok to spawn nested subagents. Defaults to false." },
        confirm_subagents: { type: "boolean", description: "Must be true when enabling nested Grok subagents." },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 600 }
      },
      required: ["task", "cwd"],
      additionalProperties: false
    },
    annotations: { title: "Start project-read-only Grok agent", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "grok_spawn_worker",
    description: "Start Grok Build with workspace write access, but only inside a linked Git worktree. Requires explicit confirmation of write scope.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Bounded implementation task and verification requirements." },
        worktree: { type: "string", description: "Absolute path to a linked Git worktree; primary checkouts are rejected." },
        confirm_write_scope: { type: "boolean", description: "Must be true after the user explicitly authorizes Grok to edit this worktree." },
        role: { type: "string", description: "Short specialist role." },
        model: { type: "string", description: "Optional Grok Build model ID. Explicit input overrides plugin and Grok defaults." },
        reasoning_effort: { type: "string", description: "Optional reasoning effort supported by the selected model." },
        session_mode: { type: "string", enum: ["agent", "plan"], description: "Agent mode writes immediately; plan mode stays read-only until grok_plan_decide approves the plan." },
        agent_profile: { type: "string", description: "Optional named Grok agent profile discovered by grok inspect." },
        subagents_enabled: { type: "boolean", description: "Allow nested Grok subagents inside the linked worktree." },
        confirm_subagents: { type: "boolean", description: "Must be true when enabling nested Grok subagents." },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 900 }
      },
      required: ["task", "worktree", "confirm_write_scope"],
      additionalProperties: false
    },
    annotations: { title: "Start isolated Grok worker", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "grok_handoff_interactive",
    description: "Open an independent interactive Grok Build TUI in a new macOS Terminal window. Codex hands off the prompt and does not supervise the session.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Complete task brief that Codex hands to the interactive Grok session." },
        cwd: { type: "string", description: "Absolute project directory. Worktree mode requires the Git repository root." },
        access_mode: { type: "string", enum: ["read_only", "isolated_worktree"], description: "Read-only inspection or edits in a Grok-created linked worktree." },
        confirm_interactive_handoff: { type: "boolean", description: "Must be true after the user explicitly asks to interact directly with Grok in a separate window." },
        role: { type: "string", description: "Optional specialist role included in the handoff prompt." },
        model: { type: "string", description: "Optional Grok Build model ID." },
        reasoning_effort: { type: "string", description: "Optional reasoning effort." },
        session_mode: { type: "string", enum: ["agent", "plan"], description: "Initial interactive session mode." },
        agent_profile: { type: "string", description: "Optional named Grok agent profile." },
        subagents_enabled: { type: "boolean", description: "Allow nested Grok subagents in the interactive session." },
        confirm_subagents: { type: "boolean", description: "Must be true when enabling nested Grok subagents." }
      },
      required: ["task", "cwd", "access_mode", "confirm_interactive_handoff"],
      additionalProperties: false
    },
    annotations: { title: "Hand off to interactive Grok", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "grok_search",
    description: "Run an isolated Grok 4.5 research task with X Search, web search, and web fetch from a private directory outside the current repository. Use for X/Twitter, Reddit, community sentiment, and real-time public research.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Complete research request in the user's language." },
        platform: { type: "string", enum: ["auto", "x", "reddit", "web"], description: "Search focus hint. Not an exclusion rule. Defaults to auto." },
        depth: { type: "string", enum: ["quick", "deep"], description: "quick returns Grok's answer fast; deep asks Grok to cross-check more carefully. Defaults to quick." },
        since: { type: "string", description: "Optional relative window such as 24h, 7d, 2w, or an ISO-8601 start timestamp." },
        until: { type: "string", description: "Optional ISO-8601 end timestamp. Defaults to now." },
        keep_run: { type: "boolean", description: "Pin this run so cleanup does not delete it." },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 600 }
      },
      required: ["query"],
      additionalProperties: false
    },
    annotations: { title: "Search with Grok", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "grok_search_list",
    description: "List retained isolated Grok search runs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readOnlyAnnotations("List Grok search runs")
  },
  {
    name: "grok_search_show",
    description: "Read the full retained answer from a previous Grok search run.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Search run ID returned by grok_search or grok_search_list." }
      },
      required: ["run_id"],
      additionalProperties: false
    },
    annotations: readOnlyAnnotations("Show Grok search run")
  },
  {
    name: "grok_capabilities",
    description: "Inspect the installed Grok Build version, models, named agents, config sources, and Grok Subagent defaults without starting an inference turn.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string", description: "Optional absolute project directory used for Grok discovery." } },
      additionalProperties: false
    },
    annotations: { title: "Inspect Grok capabilities", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "grok_session_configure",
    description: "Change an idle managed Grok session's model, reasoning effort, or Agent/Plan mode through ACP.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        model: { type: "string" },
        reasoning_effort: { type: "string" },
        session_mode: { type: "string", enum: ["agent", "plan"] }
      },
      required: ["agent_id"],
      additionalProperties: false
    },
    annotations: { title: "Configure Grok session", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "grok_plan_decide",
    description: "Approve, request changes to, or cancel a pending Grok plan. Approving a worker plan starts a fresh write-enabled process in its linked worktree.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        action: { type: "string", enum: ["approve", "request_changes", "cancel"] },
        feedback: { type: "string", description: "Required when requesting plan changes." },
        confirm_write_scope: { type: "boolean", description: "Required to approve a writing plan after explicit user authorization." }
      },
      required: ["agent_id", "action"],
      additionalProperties: false
    },
    annotations: { title: "Decide Grok plan", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "grok_command",
    description: "Run one slash command that the Grok ACP session currently advertises and the Grok Subagent allowlist permits.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        command: { type: "string", description: "Command name with or without a leading slash." },
        arguments: { type: "string", description: "Optional command arguments." },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 600 },
        confirm_write_scope: { type: "boolean", description: "Required for commands in writing agents." }
      },
      required: ["agent_id", "command"],
      additionalProperties: false
    },
    annotations: { title: "Run safe Grok command", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "grok_config_get",
    description: "Read Grok Subagent's persistent defaults. This does not return secrets or raw Grok hook commands.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readOnlyAnnotations("Read Grok Subagent config")
  },
  {
    name: "grok_config_set",
    description: "Atomically update allowlisted Grok Subagent defaults without modifying Grok's native config.toml.",
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "object",
          properties: {
            default_model: { type: ["string", "null"] },
            default_reasoning_effort: { type: ["string", "null"] },
            default_session_mode: { type: "string", enum: ["agent", "plan"] },
            default_agent_profile: { type: ["string", "null"] },
            default_subagents_enabled: { type: "boolean" },
            allowed_slash_commands: { type: "array", items: { type: "string" } }
          },
          additionalProperties: false
        },
        confirm_persist: { type: "boolean", description: "Must be true after explicit user authorization." }
      },
      required: ["patch", "confirm_persist"],
      additionalProperties: false
    },
    annotations: { title: "Update Grok Subagent config", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "grok_progress",
    description: "Long-poll one compact, public progress snapshot for a managed Grok agent. Optimized for native Codex monitor subagents and never returns private thought chunks.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        after_revision: { type: "integer", minimum: 0, description: "Return when visible progress is newer than this revision." },
        wait_seconds: { type: "integer", minimum: 0, maximum: 30, default: 30 }
      },
      required: ["agent_id"],
      additionalProperties: false
    },
    annotations: readOnlyAnnotations("Wait for compact Grok progress")
  },
  {
    name: "grok_status",
    description: "Inspect one Grok agent's lifecycle and visible progress. Optionally wait for a newer progress revision.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        after_revision: { type: "integer", minimum: 0, description: "Return when progress is newer than this revision." },
        wait_seconds: { type: "integer", minimum: 0, maximum: 30, default: 0 }
      },
      required: ["agent_id"],
      additionalProperties: false
    },
    annotations: readOnlyAnnotations("Inspect Grok agent")
  },
  {
    name: "grok_result",
    description: "Get a Grok agent's accumulated public answer. Optionally wait briefly for the current turn to finish.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        wait_seconds: { type: "integer", minimum: 0, maximum: 30, default: 0 }
      },
      required: ["agent_id"],
      additionalProperties: false
    },
    annotations: readOnlyAnnotations("Read Grok result")
  },
  {
    name: "grok_send",
    description: "Send a focused follow-up prompt to an idle Grok agent in the same ACP session.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        message: { type: "string" },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 600 },
        confirm_write_scope: { type: "boolean", description: "Required for follow-ups to writing agents after explicit user authorization for the same scope." }
      },
      required: ["agent_id", "message"],
      additionalProperties: false
    },
    annotations: { title: "Follow up with Grok", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "grok_cancel",
    description: "Cancel the active turn for a Grok agent while keeping its ACP session available.",
    inputSchema: objectWithAgentId(),
    annotations: { title: "Cancel Grok turn", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "grok_close",
    description: "Terminate a Grok agent process and remove it from the bridge.",
    inputSchema: objectWithAgentId(),
    annotations: { title: "Close Grok agent", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "grok_list",
    description: "List all Grok agents currently owned by this bridge process.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readOnlyAnnotations("List Grok agents")
  }
];

function objectWithAgentId() {
  return { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"], additionalProperties: false };
}

function readOnlyAnnotations(title) {
  return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

function clamp(value, min, max, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string or null.`);
  return value.trim();
}

function normalizeSessionMode(value, fallback = "agent") {
  const mode = optionalString(value, "session mode") || fallback;
  if (["agent", "normal", "default"].includes(mode)) return "agent";
  if (mode === "plan") return "plan";
  throw new Error("session mode must be agent or plan.");
}

function acpModeId(mode) {
  return normalizeSessionMode(mode) === "plan" ? "plan" : "default";
}

function normalizeAgentProfile(value) {
  const profile = optionalString(value, "agent_profile");
  if (profile && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
    throw new Error("agent_profile must be a discovered Grok agent name, not a path or inline definition.");
  }
  return profile;
}

function normalizeSlashCommand(value) {
  const command = optionalString(value, "slash command")?.replace(/^\/+/, "") || "";
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(command)) throw new Error("slash command name is invalid.");
  return command;
}

function normalizePluginConfig(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin config must be a JSON object.");
  const commands = value.allowed_slash_commands === undefined
    ? DEFAULT_SLASH_COMMANDS
    : value.allowed_slash_commands;
  if (!Array.isArray(commands)) throw new Error("allowed_slash_commands must be an array.");
  const allowedSlashCommands = [...new Set(commands.map(normalizeSlashCommand))];
  for (const command of allowedSlashCommands) {
    if (HARD_BLOCKED_SLASH_COMMANDS.has(command)) throw new Error(`Slash command /${command} cannot be allowlisted.`);
  }
  return {
    schema_version: 1,
    default_model: optionalString(value.default_model, "default_model"),
    default_reasoning_effort: optionalString(value.default_reasoning_effort, "default_reasoning_effort"),
    default_session_mode: normalizeSessionMode(value.default_session_mode, "agent"),
    default_agent_profile: normalizeAgentProfile(value.default_agent_profile),
    default_subagents_enabled: value.default_subagents_enabled === true,
    allowed_slash_commands: allowedSlashCommands
  };
}

function pluginConfigPath(source = process.env) {
  if (source.GROK_SUBAGENT_CONFIG_FILE) {
    if (!isAbsolute(source.GROK_SUBAGENT_CONFIG_FILE)) throw new Error("GROK_SUBAGENT_CONFIG_FILE must be absolute.");
    return resolve(source.GROK_SUBAGENT_CONFIG_FILE);
  }
  const base = source.XDG_CONFIG_HOME ? resolve(source.XDG_CONFIG_HOME) : join(homedir(), ".config");
  return join(base, "grok-subagent", "config.json");
}

function readPluginConfig(source = process.env) {
  const path = pluginConfigPath(source);
  try {
    return { path, exists: true, config: normalizePluginConfig(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    if (error?.code === "ENOENT") return { path, exists: false, config: normalizePluginConfig(DEFAULT_PLUGIN_CONFIG) };
    throw new Error(`Could not read Grok Subagent config: ${cleanText(error?.message || error)}`);
  }
}

function writePluginConfig(patch, confirmPersist, source = process.env) {
  if (confirmPersist !== true) throw new Error("confirm_persist must be true after explicit user authorization.");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("patch must be an object.");
  for (const key of Object.keys(patch)) {
    if (!PLUGIN_CONFIG_KEYS.has(key)) throw new Error(`Unsupported plugin config key: ${key}`);
  }
  const current = readPluginConfig(source);
  const config = normalizePluginConfig({ ...current.config, ...patch });
  const directory = dirname(current.path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, current.path);
    chmodSync(current.path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { path: current.path, exists: true, config };
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/(authorization|api[-_ ]?key|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|password|cookie|token)(\s*["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, "$1$2[REDACTED]")
    .replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED AWS ACCESS KEY]");
}

function appendBounded(current, addition, max = MAX_TEXT) {
  const combined = current + cleanText(addition);
  return combined.length <= max ? combined : combined.slice(combined.length - max);
}

function absoluteDirectory(input, label) {
  if (typeof input !== "string" || !input.trim()) throw new Error(`${label} is required.`);
  if (!isAbsolute(input)) throw new Error(`${label} must be an absolute path.`);
  const path = resolve(input);
  accessSync(path, constants.R_OK);
  if (!statSync(path).isDirectory()) throw new Error(`${label} must be a directory.`);
  return realpathSync(path);
}

function assertLinkedWorktree(input) {
  const path = absoluteDirectory(input, "worktree");
  const probe = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5_000, env: buildChildEnv() });
  if (probe.status !== 0) throw new Error("Writing agents require a valid Git linked worktree.");
  const gitRoot = realpathSync(resolve(probe.stdout.trim()));
  if (gitRoot !== path) throw new Error("worktree must be the root of the linked Git worktree.");
  let marker;
  try { marker = lstatSync(join(path, ".git")); } catch { throw new Error("Writing agents require a linked Git worktree with a .git file."); }
  if (!marker.isFile()) throw new Error("Primary checkouts are rejected. Create a linked Git worktree, whose .git entry is a file.");
  return path;
}

function assertGitRepositoryRoot(input) {
  const path = absoluteDirectory(input, "cwd");
  const probe = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5_000, env: buildChildEnv() });
  if (probe.status !== 0) throw new Error("Interactive worktree handoff requires a Git repository root.");
  const gitRoot = realpathSync(resolve(probe.stdout.trim()));
  if (gitRoot !== path) throw new Error("cwd must be the root of the Git repository for interactive worktree handoff.");
  return path;
}

function buildChildEnv(source = process.env) {
  const env = {};
  for (const key of CHILD_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  const extraKeys = String(source.GROK_PASSTHROUGH_ENV || "")
    .split(",")
    .map(key => key.trim())
    .filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  for (const key of extraKeys) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

function negotiateProtocolVersion(requested) {
  return SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
}

function findGrok() {
  const candidates = [process.env.GROK_BIN, join(homedir(), ".grok", "bin", "grok"), "grok"].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5_000, env: buildChildEnv() });
    if (probe.status === 0) return candidate;
  }
  throw new Error("Grok CLI was not found. Install and authenticate Grok Build first.");
}

function runGrokJson(binary, args, cwd, timeout = 30_000) {
  const result = spawnSync(binary, args, { cwd, encoding: "utf8", timeout, env: buildChildEnv(), maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(cleanText(result.stderr || result.stdout || `grok ${args[0]} exited with ${result.status}`));
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`grok ${args[0]} did not return valid JSON.`); }
}

function parseModelsOutput(output) {
  const defaultModel = String(output).match(/^Default model:\s*(\S+)/m)?.[1] || null;
  const models = [...String(output).matchAll(/^\s*[*-]\s+(\S+?)(?:\s+\(default\))?\s*$/gm)].map(match => match[1]);
  return { default_model: defaultModel, available_models: [...new Set(models)] };
}

function getGrokCapabilities(args = {}) {
  const cwd = args.cwd ? absoluteDirectory(args.cwd, "cwd") : realpathSync(process.cwd());
  const binary = findGrok();
  const versionProbe = spawnSync(binary, ["--version"], { cwd, encoding: "utf8", timeout: 5_000, env: buildChildEnv() });
  const modelsProbe = spawnSync(binary, ["models"], { cwd, encoding: "utf8", timeout: 30_000, env: buildChildEnv() });
  if (modelsProbe.status !== 0) throw new Error(cleanText(modelsProbe.stderr || modelsProbe.stdout || "Could not list Grok models."));
  const inspect = runGrokJson(binary, ["inspect", "--json"], cwd);
  const models = parseModelsOutput(modelsProbe.stdout);
  return {
    grok_version: cleanText(versionProbe.stdout || versionProbe.stderr).trim(),
    cwd,
    ...models,
    agents: (inspect.agents || []).slice(0, 100).map(agent => ({
      name: cleanText(agent.name),
      description: cleanText(agent.description || ""),
      source: cleanText(agent.source?.type || "unknown")
    })),
    config_sources: (inspect.configSources?.layers || []).map(layer => ({ role: cleanText(layer.role), path: cleanText(layer.path) })),
    supported_session_modes: ["agent", "plan"],
    plugin_config: readPluginConfig()
  };
}

function buildManagedAgentArgs({ sandbox, model, reasoningEffort, agentProfile, subagentsEnabled }) {
  const args = ["--no-auto-update", "--sandbox", sandbox];
  if (agentProfile) args.push("--agent", agentProfile);
  if (!subagentsEnabled) args.push("--no-subagents");
  args.push("agent");
  if (model) args.push("--model", model);
  if (reasoningEffort) args.push("--reasoning-effort", reasoningEffort);
  args.push("--always-approve", "--no-leader", "stdio");
  return args;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function appleScriptString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function interactiveWorktreeName() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `grok-handoff-${stamp}-${randomUUID().slice(0, 6)}`;
}

function buildInteractiveCommand({ binary, cwd, promptFile, promptDir, accessMode, model, reasoningEffort, sessionMode, agentProfile, subagentsEnabled, worktreeName }) {
  const args = [shellQuote(binary)];
  if (agentProfile) args.push("--agent", shellQuote(agentProfile));
  if (!subagentsEnabled) args.push("--no-subagents");
  if (model) args.push("--model", shellQuote(model));
  if (reasoningEffort) args.push("--reasoning-effort", shellQuote(reasoningEffort));
  if (accessMode === "read_only") {
    args.push("--sandbox", "read-only", "--permission-mode", sessionMode === "plan" ? "plan" : "default");
  } else {
    args.push(`--worktree=${shellQuote(worktreeName)}`, "--sandbox", "workspace", "--permission-mode", sessionMode === "plan" ? "plan" : "acceptEdits");
  }
  args.push('--', '"$grok_handoff_prompt"');
  return [
    `cd ${shellQuote(cwd)}`,
    `grok_handoff_prompt="$(cat -- ${shellQuote(promptFile)})"`,
    `{ rm -f -- ${shellQuote(promptFile)}; rmdir -- ${shellQuote(promptDir)} 2>/dev/null || true; exec ${args.join(" ")}; }`
  ].join(" && ");
}

function launchInteractiveHandoff(args) {
  if (process.platform !== "darwin") throw new Error("Interactive Terminal handoff is currently supported only on macOS.");
  if (args.confirm_interactive_handoff !== true) {
    throw new Error("confirm_interactive_handoff must be true after the user explicitly requests a separate interactive Grok window.");
  }
  if (typeof args.task !== "string" || !args.task.trim()) throw new Error("task is required.");
  if (args.task.length > MAX_TEXT) throw new Error(`task must be at most ${MAX_TEXT} characters.`);
  if (!["read_only", "isolated_worktree"].includes(args.access_mode)) throw new Error("access_mode must be read_only or isolated_worktree.");
  const config = readPluginConfig().config;
  const sessionMode = normalizeSessionMode(args.session_mode, config.default_session_mode);
  const agentProfile = normalizeAgentProfile(args.agent_profile ?? config.default_agent_profile);
  const subagentsEnabled = args.subagents_enabled ?? config.default_subagents_enabled;
  if (subagentsEnabled && args.confirm_subagents !== true) {
    throw new Error("confirm_subagents must be true when enabling nested Grok subagents.");
  }
  const cwd = args.access_mode === "isolated_worktree" ? assertGitRepositoryRoot(args.cwd) : absoluteDirectory(args.cwd, "cwd");
  const binary = findGrok();
  const worktreeName = args.access_mode === "isolated_worktree" ? interactiveWorktreeName() : null;
  const rules = [
    `Codex has handed this task to you as an interactive ${cleanText(args.role || "Grok Build specialist")}.`,
    "Work directly with the user in this Terminal window. Ask the user when a material decision or additional authority is required.",
    subagentsEnabled ? "Keep any nested subagent fan-out bounded and report it." : "Do not spawn subagents.",
    args.access_mode === "read_only"
      ? "This is a read-only session. Do not modify project files."
      : "Work only in the isolated worktree created for this session. Do not commit, push, merge, publish, or alter other worktrees unless the user explicitly authorizes that action in this window.",
    "When finished, summarize the changes, tests, remaining risks, and the worktree path so the user can return to Codex for independent verification.",
    "",
    "Task from Codex:",
    cleanText(args.task)
  ].join("\n");
  const promptDir = mkdtempSync(join(tmpdir(), "grok-handoff-"));
  const promptFile = join(promptDir, "prompt.txt");
  writeFileSync(promptFile, rules, { encoding: "utf8", mode: 0o600 });
  const command = buildInteractiveCommand({
    binary,
    cwd,
    promptFile,
    promptDir,
    accessMode: args.access_mode,
    model: args.model ?? config.default_model,
    reasoningEffort: args.reasoning_effort ?? config.default_reasoning_effort,
    sessionMode,
    agentProfile,
    subagentsEnabled,
    worktreeName
  });
  const script = `tell application "Terminal"\nactivate\ndo script "${appleScriptString(command)}"\nend tell`;
  const launched = spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: 10_000, env: buildChildEnv() });
  if (launched.status !== 0) {
    rmSync(promptDir, { recursive: true, force: true });
    throw new Error(`Could not open the interactive Grok Terminal window: ${cleanText(launched.stderr || launched.stdout || "unknown error")}`);
  }
  const cleanupTimer = setTimeout(() => rmSync(promptDir, { recursive: true, force: true }), 60_000);
  cleanupTimer.unref();
  return {
    launched: true,
    supervision: "user",
    access_mode: args.access_mode,
    cwd,
    worktree_name: worktreeName,
    note: "This Terminal session is independent. Return to Codex when you want its result or diff verified."
  };
}

class GrokAgent {
  constructor({ cwd, mode, role, model, reasoningEffort, sessionMode, agentProfile, subagentsEnabled, timeoutSeconds, originalTask }) {
    this.id = randomUUID();
    this.cwd = cwd;
    this.mode = mode;
    this.role = cleanText(role || (mode === "readonly" ? "independent investigator" : "isolated implementation worker"));
    this.model = model || null;
    this.reasoningEffort = reasoningEffort || null;
    this.sessionMode = normalizeSessionMode(sessionMode);
    this.agentProfile = normalizeAgentProfile(agentProfile);
    this.subagentsEnabled = subagentsEnabled === true;
    this.timeoutSeconds = timeoutSeconds;
    this.originalTask = cleanText(originalTask || "");
    this.runtimeMode = mode === "worker" && this.sessionMode === "plan" ? "readonly" : mode;
    this.phase = this.sessionMode === "plan" ? "planning" : "agent";
    this.status = "starting";
    this.sessionId = null;
    this.text = "";
    this.stderr = "";
    this.plan = null;
    this.planApproval = null;
    this.approvedPlan = null;
    this.availableModels = [];
    this.availableCommands = [];
    this.toolEvents = [];
    this.error = null;
    this.startedAt = new Date().toISOString();
    this.updatedAt = this.startedAt;
    this.revision = 0;
    this.requestId = 0;
    this.pending = new Map();
    this.turnPromise = null;
    this.cancelTimer = null;
    this.closed = false;
    this.proc = null;
  }

  async start() {
    await this.startProcess();
  }

  async startProcess() {
    const binary = findGrok();
    const sandbox = this.runtimeMode === "readonly" ? "read-only" : "workspace";
    const args = buildManagedAgentArgs({
      sandbox,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      agentProfile: this.agentProfile,
      subagentsEnabled: this.subagentsEnabled
    });
    this.status = "starting";
    this.stderr = "";
    const proc = spawn(binary, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], env: buildChildEnv() });
    this.proc = proc;
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", chunk => {
      if (proc === this.proc) this.stderr = appendBounded(this.stderr, chunk, MAX_STDERR);
    });
    proc.on("exit", (code, signal) => this.onExit(proc, code, signal));
    proc.on("error", error => {
      if (proc === this.proc) this.fail(error);
    });
    const lines = createInterface({ input: proc.stdout });
    lines.on("line", line => this.onLine(proc, line));

    const initialized = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 30_000);
    const methods = initialized?.authMethods || [];
    if (methods.some(method => method.id === "cached_token")) {
      await this.request("authenticate", { methodId: "cached_token" }, 30_000);
    }
    const rules = [
      `You are acting as a ${this.role} under Codex orchestration.`,
      this.subagentsEnabled
        ? "Nested Grok subagents are authorized for this task. Keep fan-out bounded and report their work."
        : "Do not spawn or delegate to other agents.",
      "Do not expose private chain-of-thought; provide concise conclusions and verifiable evidence.",
      this.runtimeMode === "readonly"
        ? (this.phase === "planning"
          ? "This is a read-only planning phase. Inspect the project, produce a concrete plan, and request plan approval. Do not modify project files."
          : "This session is read-only. Do not attempt to modify project files.")
        : "Modify only the requested files inside this isolated linked worktree. Do not commit, push, merge, or alter other worktrees."
    ].join("\n");
    const session = await this.request("session/new", { cwd: this.cwd, mcpServers: [], _meta: { rules } }, 30_000);
    if (!session?.sessionId) throw new Error("Grok ACP did not return a sessionId.");
    this.sessionId = session.sessionId;
    this.applySessionDescriptor(session);
    if (this.sessionMode === "plan") await this.setSessionMode("plan");
    this.status = "idle";
    this.touch();
  }

  applySessionDescriptor(session) {
    const models = Array.isArray(session.models?.availableModels) ? session.models.availableModels : [];
    this.availableModels = models.slice(0, 100).map(model => ({
      model_id: cleanText(model.modelId),
      name: cleanText(model.name || model.modelId),
      description: cleanText(model.description || ""),
      default_reasoning_effort: cleanText(model._meta?.reasoningEffort || "") || null,
      reasoning_efforts: (model._meta?.reasoningEfforts || []).slice(0, 20).map(effort => ({
        id: cleanText(effort.id || effort.value),
        label: cleanText(effort.label || effort.id || effort.value),
        description: cleanText(effort.description || "")
      }))
    }));
    const currentModelId = optionalString(session.models?.currentModelId, "current model") || this.model;
    if (currentModelId) this.model = currentModelId;
    const current = models.find(model => model.modelId === currentModelId);
    if (!this.reasoningEffort && current?._meta?.reasoningEffort) this.reasoningEffort = cleanText(current._meta.reasoningEffort);
  }

  request(method, params, timeoutMs = 60_000) {
    if (this.closed || !this.proc?.stdin?.writable) return Promise.reject(new Error("Grok process is not available."));
    const id = ++this.requestId;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, method });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  write(message) {
    if (!this.proc?.stdin?.writable) throw new Error("Grok process is not writable.");
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }

  onLine(proc, line) {
    if (proc !== this.proc) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(cleanText(message.error.message || JSON.stringify(message.error))));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method === "session/update" || message.method === "x.ai/session/update") {
      this.consumeUpdate(message.params?.update || message.params);
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) this.handleAgentRequest(message);
  }

  handleAgentRequest(message) {
    const kind = message.params?.toolCall?.kind;
    if (message.method.includes("exit_plan_mode") || kind === "switch_mode") {
      const content = message.params?.planContent
        || message.params?.toolCall?.content?.map(item => item?.content?.text || item?.text || "").join("\n")
        || JSON.stringify(this.plan || []);
      this.planApproval = {
        id: message.id,
        method: message.method,
        params: message.params || {},
        plan_content: cleanText(content).slice(0, MAX_TEXT),
        received_at: new Date().toISOString()
      };
      this.status = "awaiting_plan_approval";
      this.touch();
      return;
    }
    const options = message.params?.options || [];
    const allowed = options.find(option => ["allow_once", "allow", "allow_always", "approved"].includes(option.kind));
    if (message.method.includes("permission") && allowed) {
      this.write({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: allowed.optionId } } });
    } else {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client method" } });
    }
  }

  consumeUpdate(update) {
    if (!update || typeof update !== "object") return;
    if (update.sessionUpdate === "agent_message_chunk") {
      this.touch();
      this.text = appendBounded(this.text, update.content?.text || "");
    } else if (update.sessionUpdate === "plan") {
      this.touch();
      this.plan = sanitizePlan(update);
    } else if (update.sessionUpdate === "current_mode_update") {
      this.sessionMode = update.currentModeId === "plan" ? "plan" : "agent";
      this.touch();
    } else if (update.sessionUpdate === "available_commands_update") {
      this.availableCommands = (update.availableCommands || []).slice(0, 200).map(command => ({
        name: cleanText(command.name || ""),
        description: cleanText(command.description || ""),
        input_hint: cleanText(command.input?.hint || "")
      })).filter(command => command.name);
      this.touch();
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.touch();
      this.toolEvents.push({
        type: update.sessionUpdate,
        title: cleanText(update.title || update.kind || "tool"),
        status: cleanText(update.status || "unknown"),
        at: this.updatedAt,
        revision: this.revision
      });
      this.toolEvents = this.toolEvents.slice(-20);
    }
  }

  async setSessionMode(mode) {
    const normalized = normalizeSessionMode(mode);
    await this.request("session/set_mode", { sessionId: this.sessionId, modeId: acpModeId(normalized) }, 30_000);
    this.sessionMode = normalized;
    this.touch();
  }

  async configure(args = {}) {
    if (!["idle", "completed"].includes(this.status)) throw new Error(`Agent is ${this.status}; configure it only between turns.`);
    if (args.model === undefined && args.reasoning_effort === undefined && args.session_mode === undefined) {
      throw new Error("Provide model, reasoning_effort, or session_mode.");
    }
    if (args.model !== undefined || args.reasoning_effort !== undefined) {
      const model = optionalString(args.model, "model") || this.model;
      if (!model) throw new Error("A model is required before changing reasoning effort.");
      const descriptor = this.availableModels.find(item => item.model_id === model);
      if (this.availableModels.length && !descriptor) {
        throw new Error(`Model ${model} is not advertised by this Grok session.`);
      }
      const modelChanged = args.model !== undefined && model !== this.model;
      const effort = optionalString(args.reasoning_effort, "reasoning_effort")
        || (modelChanged ? descriptor?.default_reasoning_effort : this.reasoningEffort);
      if (effort && descriptor?.reasoning_efforts?.length && !descriptor.reasoning_efforts.some(item => item.id === effort)) {
        throw new Error(`Reasoning effort ${effort} is not supported by model ${model}.`);
      }
      const result = await this.request("session/set_model", {
        sessionId: this.sessionId,
        modelId: model,
        ...(effort ? { _meta: { reasoningEffort: effort } } : {})
      }, 30_000);
      if (result?._meta?.model?.Err) throw new Error(cleanText(result._meta.model.Err));
      this.model = cleanText(result?._meta?.model?.Ok || model);
      this.reasoningEffort = effort || null;
      this.touch();
    }
    if (args.session_mode !== undefined) {
      const nextMode = normalizeSessionMode(args.session_mode);
      if (this.mode === "worker" && this.runtimeMode === "worker" && nextMode === "plan") {
        throw new Error("A write-enabled worker cannot switch into a falsely read-only Plan mode. Start a new worker with session_mode=plan.");
      }
      await this.setSessionMode(nextMode);
      this.phase = nextMode === "plan" ? "planning" : "agent";
    }
    return this.summary(false);
  }

  runTurn(prompt, timeoutSeconds = this.timeoutSeconds) {
    if (!["idle", "completed"].includes(this.status)) throw new Error(`Agent is ${this.status}; wait for the current turn to settle or close it before sending another prompt.`);
    this.status = "running";
    this.error = null;
    this.touch();
    const boundedTimeout = clamp(timeoutSeconds, 30, 1800, this.timeoutSeconds) * 1000;
    const turn = this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: cleanText(prompt) }]
    }, boundedTimeout).then(result => {
      this.clearCancelTimer();
      if (result?._meta?.modelId) this.model = cleanText(result._meta.modelId);
      this.status = this.status === "cancelling" ? "idle" : "completed";
      this.touch();
      return result;
    }).catch(error => {
      this.clearCancelTimer();
      if (this.status === "cancelling") {
        this.status = "idle";
        this.touch();
        return { stopReason: "cancelled" };
      }
      if (this.closed) return { stopReason: "closed" };
      this.fail(error);
      throw error;
    }).finally(() => {
      if (this.turnPromise === turn) this.turnPromise = null;
    });
    this.turnPromise = turn;
    this.turnPromise.catch(() => {});
    return turn;
  }

  respondToPlanRequest(approval, action) {
    if (approval.method.includes("exit_plan_mode")) {
      this.write({ jsonrpc: "2.0", id: approval.id, result: { outcome: "approved" } });
      return;
    }
    const options = approval.params?.options || [];
    const preferredKinds = action === "approve"
      ? ["allow_once", "allow", "allow_always", "approved"]
      : ["reject_once", "reject", "cancelled"];
    const selected = options.find(option => preferredKinds.includes(option.kind));
    if (!selected) throw new Error(`Grok did not provide a compatible plan ${action} option.`);
    this.write({ jsonrpc: "2.0", id: approval.id, result: { outcome: { outcome: "selected", optionId: selected.optionId } } });
  }

  async decidePlan(args) {
    const action = args.action;
    if (!["approve", "request_changes", "cancel"].includes(action)) throw new Error("Invalid plan action.");
    if (!this.planApproval) throw new Error("This Grok agent has no pending plan approval.");
    const feedback = optionalString(args.feedback, "feedback");
    if (action === "request_changes" && !feedback) throw new Error("feedback is required when requesting plan changes.");
    if (action === "approve" && this.mode === "worker" && args.confirm_write_scope !== true) {
      throw new Error("confirm_write_scope must be true to approve a writing plan.");
    }
    const approval = this.planApproval;
    const currentTurn = this.turnPromise;
    this.planApproval = null;
    this.status = "running";
    this.touch();
    this.respondToPlanRequest(approval, action);
    if (currentTurn) await currentTurn;

    if (action === "request_changes") {
      await this.setSessionMode("plan");
      this.phase = "planning";
      this.runTurn(`Do not implement yet. Stay in plan mode and revise the plan based on this feedback:\n\n${feedback}`);
      return this.summary(false);
    }
    if (action === "cancel") {
      await this.setSessionMode("agent");
      this.phase = "cancelled";
      this.status = "completed";
      this.touch();
      return this.summary(false);
    }

    await this.setSessionMode("agent");
    this.phase = "agent";
    if (this.mode === "worker" && this.runtimeMode === "readonly") {
      this.approvedPlan = approval.plan_content || JSON.stringify(this.plan || []);
      await this.restartAsWorker();
      const implementationPrompt = [
        "Implement the approved plan in this isolated linked worktree.",
        "Do not commit, push, merge, or alter other worktrees.",
        "",
        "Original task:",
        this.originalTask,
        "",
        "Approved plan:",
        this.approvedPlan
      ].join("\n");
      this.runTurn(implementationPrompt);
    }
    return this.summary(false);
  }

  async restartAsWorker() {
    const previous = this.proc;
    this.proc = null;
    this.sessionId = null;
    this.availableCommands = [];
    this.planApproval = null;
    this.runtimeMode = "worker";
    this.sessionMode = "agent";
    this.phase = "implementing";
    this.terminateProcess(previous);
    await this.startProcess();
  }

  runSlashCommand(args) {
    const command = normalizeSlashCommand(args.command);
    const config = readPluginConfig().config;
    if (HARD_BLOCKED_SLASH_COMMANDS.has(command)) throw new Error(`Slash command /${command} is blocked by policy.`);
    if (!config.allowed_slash_commands.includes(command)) throw new Error(`Slash command /${command} is not in allowed_slash_commands.`);
    if (!this.availableCommands.some(item => item.name === command)) throw new Error(`Grok did not advertise slash command /${command} for this session.`);
    if (this.mode === "worker" && this.runtimeMode === "worker" && args.confirm_write_scope !== true) {
      throw new Error("confirm_write_scope must be true for commands in writing agents.");
    }
    const commandArgs = optionalString(args.arguments, "arguments");
    if (commandArgs && commandArgs.length > 20_000) throw new Error("arguments must be at most 20,000 characters.");
    this.runTurn(`/${command}${commandArgs ? ` ${cleanText(commandArgs)}` : ""}`, clamp(args.timeout_seconds, 30, 1800, 600));
    return this.summary(false);
  }

  cancel() {
    if (!this.sessionId || this.closed || !["running", "awaiting_plan_approval"].includes(this.status)) return false;
    if (this.planApproval) {
      try { this.respondToPlanRequest(this.planApproval, "cancel"); } catch {}
      this.planApproval = null;
    }
    this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    this.status = "cancelling";
    this.touch();
    this.clearCancelTimer();
    this.cancelTimer = setTimeout(() => {
      if (this.status === "cancelling") this.fail(new Error("Grok cancellation timed out."));
    }, CANCEL_TIMEOUT_MS);
    this.cancelTimer.unref();
    return true;
  }

  clearCancelTimer() {
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = null;
  }

  terminateProcess(proc = this.proc) {
    if (!proc || proc.killed || proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }, 1500).unref();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.status = "closed";
    this.touch();
    this.clearCancelTimer();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Grok agent closed."));
    }
    this.pending.clear();
    this.terminateProcess();
  }

  onExit(proc, code, signal) {
    if (proc !== this.proc || this.closed || this.status === "failed") return;
    const reason = `Grok process exited (${signal || code}).`;
    this.fail(new Error(reason));
  }

  fail(error) {
    if (this.closed || this.status === "failed") return;
    this.error = cleanText(error?.message || error);
    if (this.stderr.trim()) this.error += `\n${cleanText(this.stderr.trim()).slice(-2000)}`;
    this.status = "failed";
    this.touch();
    this.clearCancelTimer();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(this.error));
    }
    this.pending.clear();
    this.terminateProcess();
  }

  touch() {
    this.updatedAt = new Date().toISOString();
    this.revision += 1;
  }

  summary(includeText = false) {
    const allowed = new Set(readPluginConfig().config.allowed_slash_commands);
    const result = {
      agent_id: this.id,
      status: this.status,
      phase: this.phase,
      mode: this.mode,
      runtime_access: this.runtimeMode,
      session_mode: this.sessionMode,
      role: this.role,
      model: this.model,
      reasoning_effort: this.reasoningEffort,
      agent_profile: this.agentProfile,
      subagents_enabled: this.subagentsEnabled,
      cwd: this.cwd,
      started_at: this.startedAt,
      updated_at: this.updatedAt,
      elapsed_seconds: Math.max(0, Math.trunc((Date.now() - Date.parse(this.startedAt)) / 1000)),
      revision: this.revision,
      plan: this.plan,
      pending_plan_approval: this.planApproval ? {
        received_at: this.planApproval.received_at,
        plan_content: this.planApproval.plan_content
      } : null,
      available_models: this.availableModels,
      available_commands: this.availableCommands.map(command => ({
        ...command,
        allowed: allowed.has(command.name) && !HARD_BLOCKED_SLASH_COMMANDS.has(command.name)
      })),
      recent_tools: this.toolEvents,
      error: this.error
    };
    if (includeText) result.response = this.text;
    else {
      result.response_chars = this.text.length;
      result.public_response_preview = this.text.slice(-1000);
    }
    return result;
  }
}

function sanitizePlan(update) {
  const entries = update.entries || update.plan || [];
  if (!Array.isArray(entries)) return cleanText(JSON.stringify(entries)).slice(0, 6000);
  return entries.slice(0, 30).map(entry => ({ content: cleanText(entry.content || entry.text || entry.title || ""), status: cleanText(entry.status || "pending") }));
}

function getAgent(id) {
  const agent = agents.get(id);
  if (!agent) throw new Error(`Unknown Grok agent: ${id}`);
  return agent;
}

async function spawnAgent(args, mode) {
  pruneFailedAgents();
  const activeAgents = [...agents.values()].filter(agent => !["failed", "closed"].includes(agent.status));
  if (activeAgents.length >= MAX_AGENTS) throw new Error(`At most ${MAX_AGENTS} Grok agents may be open. Close one first.`);
  if (typeof args.task !== "string" || !args.task.trim()) throw new Error("task is required.");
  if (mode === "worker" && args.confirm_write_scope !== true) throw new Error("confirm_write_scope must be true after explicit user authorization.");
  const config = readPluginConfig().config;
  const subagentsEnabled = args.subagents_enabled ?? config.default_subagents_enabled;
  if (subagentsEnabled && args.confirm_subagents !== true) {
    throw new Error("confirm_subagents must be true when enabling nested Grok subagents.");
  }
  const cwd = mode === "readonly" ? absoluteDirectory(args.cwd, "cwd") : assertLinkedWorktree(args.worktree);
  const agent = new GrokAgent({
    cwd,
    mode,
    role: args.role,
    model: args.model ?? config.default_model ?? process.env.GROK_MODEL ?? null,
    reasoningEffort: args.reasoning_effort ?? config.default_reasoning_effort,
    sessionMode: args.session_mode ?? config.default_session_mode,
    agentProfile: args.agent_profile ?? config.default_agent_profile,
    subagentsEnabled,
    originalTask: args.task,
    timeoutSeconds: clamp(args.timeout_seconds, 30, 1800, mode === "readonly" ? 600 : 900)
  });
  agents.set(agent.id, agent);
  try {
    await agent.start();
    agent.runTurn(args.task);
  } catch (error) {
    agent.close();
    agents.delete(agent.id);
    throw error;
  }
  return agent.summary(false);
}

function pruneFailedAgents() {
  const failed = [...agents.values()]
    .filter(agent => agent.status === "failed")
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  while (failed.length > MAX_RETAINED_FAILED_AGENTS) {
    const agent = failed.shift();
    agent.close();
    agents.delete(agent.id);
  }
}

async function waitForAgent(agent, seconds) {
  const deadline = Date.now() + clamp(seconds, 0, 30, 0) * 1000;
  while (ACTIVE_STATUSES.has(agent.status) && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
}

async function waitForRevision(agent, afterRevision, seconds) {
  if (!Number.isInteger(afterRevision) || afterRevision < 0) return;
  const deadline = Date.now() + clamp(seconds, 0, 30, 0) * 1000;
  while (agent.revision <= afterRevision && ACTIVE_STATUSES.has(agent.status) && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
}

function progressSnapshot(agent, afterRevision) {
  const hasCursor = Number.isInteger(afterRevision) && afterRevision >= 0;
  const approvalContent = agent.planApproval?.plan_content || "";
  return {
    agent_id: agent.id,
    status: agent.status,
    phase: agent.phase,
    revision: agent.revision,
    changed: !hasCursor || agent.revision > afterRevision,
    elapsed_seconds: Math.max(0, Math.trunc((Date.now() - Date.parse(agent.startedAt)) / 1000)),
    model: agent.model,
    reasoning_effort: agent.reasoningEffort,
    session_mode: agent.sessionMode,
    runtime_access: agent.runtimeMode,
    action_required: agent.planApproval ? "plan_approval" : (agent.status === "failed" ? "inspect_error" : null),
    plan: agent.plan,
    pending_plan_approval: agent.planApproval ? {
      received_at: agent.planApproval.received_at,
      plan_content: approvalContent.slice(0, 12_000),
      plan_content_truncated: approvalContent.length > 12_000
    } : null,
    recent_tools: agent.toolEvents
      .filter(event => !hasCursor || event.revision > afterRevision)
      .slice(-5),
    response_chars: agent.text.length,
    public_response_preview: agent.text.slice(-1200),
    error: agent.error
  };
}


function searchScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "run_search.py");
}

function runSearchBridge(args) {
  const script = searchScriptPath();
  const result = spawnSync("python3", [script, ...args], {
    encoding: "utf8",
    timeout: 1_860_000,
    env: buildChildEnv(),
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  let payload = null;
  if (stdout) {
    try { payload = JSON.parse(stdout); }
    catch {
      // Prefer the last JSON object if the bridge printed anything else first.
      const match = stdout.match(/\{[\s\S]*\}\s*$/);
      if (match) {
        try { payload = JSON.parse(match[0]); } catch {}
      }
    }
  }
  if (payload && typeof payload === "object") {
    if (stderr) payload.bridge_stderr = cleanText(stderr).slice(-2000);
    return payload;
  }
  throw new Error(cleanText(stderr || stdout || `Search bridge exited with code ${result.status}`));
}

function callSearch(args = {}) {
  if (typeof args.query !== "string" || !args.query.trim()) throw new Error("query is required.");
  if (args.query.length > MAX_TEXT) throw new Error(`query must be at most ${MAX_TEXT} characters.`);
  const platform = args.platform || "auto";
  if (!["auto", "x", "reddit", "web"].includes(platform)) throw new Error("platform must be auto, x, reddit, or web.");
  const depth = args.depth || "quick";
  if (!["quick", "deep"].includes(depth)) throw new Error("depth must be quick or deep.");
  const command = [
    "run",
    "--platform", platform,
    "--depth", depth,
    "--timeout", String(clamp(args.timeout_seconds, 30, 1800, 600)),
    "--retention-days", "7"
  ];
  if (typeof args.since === "string" && args.since.trim()) command.push("--since", args.since.trim());
  if (typeof args.until === "string" && args.until.trim()) command.push("--until", args.until.trim());
  if (args.keep_run === true) command.push("--keep-run");
  command.push(args.query);
  const payload = runSearchBridge(command);
  if (payload.ok === true && typeof payload.result_path === "string") {
    try {
      payload.result = cleanText(readFileSync(payload.result_path, "utf8"));
    } catch (error) {
      payload.result_read_error = cleanText(error?.message || error);
    }
  }
  return payload;
}

function listSearchRuns() {
  return runSearchBridge(["list"]);
}

function showSearchRun(args = {}) {
  if (typeof args.run_id !== "string" || !args.run_id.trim()) throw new Error("run_id is required.");
  return runSearchBridge(["show", args.run_id.trim()]);
}

async function callTool(name, args = {}) {
  switch (name) {
    case "grok_spawn_readonly": return spawnAgent(args, "readonly");
    case "grok_spawn_worker": return spawnAgent(args, "worker");
    case "grok_handoff_interactive": return launchInteractiveHandoff(args);
    case "grok_search": return callSearch(args);
    case "grok_search_list": return listSearchRuns();
    case "grok_search_show": return showSearchRun(args);
    case "grok_capabilities": return getGrokCapabilities(args);
    case "grok_config_get": return readPluginConfig();
    case "grok_config_set": return writePluginConfig(args.patch, args.confirm_persist);
    case "grok_session_configure": return getAgent(args.agent_id).configure(args);
    case "grok_plan_decide": return getAgent(args.agent_id).decidePlan(args);
    case "grok_command": return getAgent(args.agent_id).runSlashCommand(args);
    case "grok_progress": {
      const agent = getAgent(args.agent_id);
      await waitForRevision(agent, args.after_revision, args.wait_seconds);
      return progressSnapshot(agent, args.after_revision);
    }
    case "grok_status": {
      const agent = getAgent(args.agent_id);
      await waitForRevision(agent, args.after_revision, args.wait_seconds);
      return {
        ...agent.summary(false),
        changed: !Number.isInteger(args.after_revision) || agent.revision > args.after_revision
      };
    }
    case "grok_result": {
      const agent = getAgent(args.agent_id);
      await waitForAgent(agent, args.wait_seconds);
      return agent.summary(true);
    }
    case "grok_send": {
      const agent = getAgent(args.agent_id);
      if (agent.mode === "worker" && args.confirm_write_scope !== true) {
        throw new Error("confirm_write_scope must be true for writing-agent follow-ups after explicit user authorization.");
      }
      agent.runTurn(args.message, clamp(args.timeout_seconds, 30, 1800, 600));
      return agent.summary(false);
    }
    case "grok_cancel": {
      const agent = getAgent(args.agent_id);
      return { agent_id: agent.id, cancelled: agent.cancel(), status: agent.status };
    }
    case "grok_close": {
      const agent = getAgent(args.agent_id);
      agent.close();
      agents.delete(agent.id);
      return { agent_id: agent.id, closed: true };
    }
    case "grok_list": return { agents: [...agents.values()].map(agent => agent.summary(false)) };
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function textResult(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

function sendMcp(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function startMcpServer() {
  const input = createInterface({ input: process.stdin });
  input.on("line", async line => {
    let request;
    try { request = JSON.parse(line); }
    catch {
      sendMcp({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (!Object.hasOwn(request, "id")) return;
    try {
      let result;
      if (request.method === "initialize") {
        result = {
          protocolVersion: negotiateProtocolVersion(request.params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "grok-subagent", version: VERSION }
        };
      } else if (request.method === "ping") {
        result = {};
      } else if (request.method === "tools/list") {
        result = { tools: TOOL_DEFINITIONS };
      } else if (request.method === "tools/call") {
        try { result = textResult(await callTool(request.params?.name, request.params?.arguments || {})); }
        catch (error) { result = textResult({ error: cleanText(error?.message || error) }, true); }
      } else {
        sendMcp({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
        return;
      }
      sendMcp({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      sendMcp({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: cleanText(error?.message || error) } });
    }
  });
  input.on("close", shutdown);
  return input;
}

function shutdown() {
  for (const agent of agents.values()) agent.close();
  agents.clear();
}

export {
  GrokAgent,
  TOOL_DEFINITIONS,
  VERSION,
  absoluteDirectory,
  appleScriptString,
  assertLinkedWorktree,
  assertGitRepositoryRoot,
  buildManagedAgentArgs,
  buildInteractiveCommand,
  buildChildEnv,
  callSearch,
  cleanText,
  listSearchRuns,
  negotiateProtocolVersion,
  normalizePluginConfig,
  normalizeSessionMode,
  pluginConfigPath,
  progressSnapshot,
  readPluginConfig,
  searchScriptPath,
  showSearchRun,
  shutdown,
  startMcpServer,
  waitForRevision,
  writePluginConfig
};

let isMainModule = false;
try {
  isMainModule = Boolean(process.argv[1])
    && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {}

if (isMainModule) {
  startMcpServer();
  process.on("SIGINT", () => { shutdown(); process.exit(0); });
  process.on("SIGTERM", () => { shutdown(); process.exit(0); });
  process.on("exit", shutdown);
}
