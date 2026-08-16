import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GrokAgent,
  TOOL_DEFINITIONS,
  appleScriptString,
  assertLinkedWorktree,
  buildManagedAgentArgs,
  buildInteractiveCommand,
  buildChildEnv,
  cleanText,
  negotiateProtocolVersion,
  normalizePluginConfig,
  progressSnapshot,
  readPluginConfig,
  searchScriptPath,
  waitForRevision,
  writePluginConfig
} from "../plugins/grok-subagent/mcp-server/server.mjs";

test("child environment excludes unrelated secrets and supports explicit passthrough", () => {
  const env = buildChildEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    XAI_API_KEY: "xai-test",
    AWS_SECRET_ACCESS_KEY: "do-not-pass",
    CUSTOM_CA_MODE: "strict",
    GROK_PASSTHROUGH_ENV: "CUSTOM_CA_MODE"
  });

  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    XAI_API_KEY: "xai-test",
    CUSTOM_CA_MODE: "strict"
  });
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
});

test("managed Grok arguments expose model, effort, profile, sandbox, and subagent policy", () => {
  assert.deepEqual(buildManagedAgentArgs({
    sandbox: "read-only",
    model: "grok-4.6",
    reasoningEffort: "xhigh",
    agentProfile: "explore",
    subagentsEnabled: false
  }), [
    "--no-auto-update", "--sandbox", "read-only", "--agent", "explore", "--no-subagents",
    "agent", "--model", "grok-4.6", "--reasoning-effort", "xhigh", "--always-approve", "--no-leader", "stdio"
  ]);
  assert(!buildManagedAgentArgs({ sandbox: "workspace", subagentsEnabled: true }).includes("--no-subagents"));
});

test("plugin defaults persist atomically with strict schema and permissions", () => {
  const base = mkdtempSync(join(tmpdir(), "grok-subagent-config-"));
  const configPath = join(base, "nested", "config.json");
  const source = { GROK_SUBAGENT_CONFIG_FILE: configPath };
  try {
    const initial = readPluginConfig(source);
    assert.equal(initial.exists, false);
    assert.equal(initial.config.default_session_mode, "agent");
    assert.throws(() => writePluginConfig({ default_model: "grok-4.6" }, false, source), /confirm_persist/);
    const written = writePluginConfig({
      default_model: "grok-4.6",
      default_reasoning_effort: "high",
      allowed_slash_commands: ["context", "/compact"]
    }, true, source);
    assert.equal(written.config.default_model, "grok-4.6");
    assert.deepEqual(written.config.allowed_slash_commands, ["context", "compact"]);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), written.config);
    assert.throws(() => normalizePluginConfig({ allowed_slash_commands: ["login"] }), /cannot be allowlisted/);
    assert.throws(() => writePluginConfig({ unknown: true }, true, source), /Unsupported plugin config key/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("credential-shaped text is redacted", () => {
  const privateKey = "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----";
  const cleaned = cleanText([
    "token=plain-secret",
    "client_secret: another-secret",
    "Authorization: Bearer abc.def.ghi",
    "xai-abcdefghijklmnop",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "AKIAABCDEFGHIJKLMNOP",
    privateKey
  ].join("\n"));

  for (const secret of ["plain-secret", "another-secret", "abc.def.ghi", "abcdefghijklmnop", "abcdefghijklmnopqrstuvwxyz123456", "AKIAABCDEFGHIJKLMNOP", "\nsecret\n"]) {
    assert(!cleaned.includes(secret), `secret was not redacted: ${secret}`);
  }
});

test("MCP protocol negotiation never echoes an unsupported version", () => {
  assert.equal(negotiateProtocolVersion("2024-11-05"), "2024-11-05");
  assert.equal(negotiateProtocolVersion("unsupported-future-version"), "2025-11-25");
  assert.equal(negotiateProtocolVersion(undefined), "2025-11-25");
});

test("tool annotations reflect process and writing side effects", () => {
  const byName = Object.fromEntries(TOOL_DEFINITIONS.map(tool => [tool.name, tool]));
  assert.equal(byName.grok_spawn_readonly.annotations.readOnlyHint, false);
  assert.equal(byName.grok_spawn_readonly.annotations.destructiveHint, false);
  assert.equal(byName.grok_send.annotations.destructiveHint, true);
  assert.equal(byName.grok_handoff_interactive.annotations.destructiveHint, true);
  assert.equal(byName.grok_close.annotations.idempotentHint, false);
  assert(byName.grok_send.inputSchema.properties.confirm_write_scope);
  assert.equal(byName.grok_progress.annotations.readOnlyHint, true);
  assert(byName.grok_progress.inputSchema.properties.after_revision);
  assert.equal(byName.grok_progress.inputSchema.properties.wait_seconds.maximum, 30);
  assert(byName.grok_status.inputSchema.properties.after_revision);
  assert.equal(byName.grok_status.inputSchema.properties.wait_seconds.maximum, 30);
  for (const name of ["grok_capabilities", "grok_session_configure", "grok_plan_decide", "grok_command", "grok_config_get", "grok_config_set"]) {
    assert(byName[name], `missing ${name}`);
  }
  assert.equal(byName.grok_capabilities.annotations.readOnlyHint, true);
  assert.equal(byName.grok_config_set.annotations.destructiveHint, true);
  assert(byName.grok_spawn_worker.inputSchema.properties.reasoning_effort);
  assert(byName.grok_spawn_worker.inputSchema.properties.session_mode);
  assert(byName.grok_spawn_worker.inputSchema.properties.subagents_enabled);
});

test("Grok sessions normalize ACP model controls and hold plan exit requests", async () => {
  const agent = new GrokAgent({
    cwd: tmpdir(),
    mode: "worker",
    role: "test",
    model: "grok-4.6",
    reasoningEffort: "xhigh",
    sessionMode: "plan",
    subagentsEnabled: false,
    timeoutSeconds: 60,
    originalTask: "test task"
  });
  assert.equal(agent.runtimeMode, "readonly");
  agent.sessionId = "session-test";
  agent.status = "idle";
  agent.applySessionDescriptor({
    models: {
      currentModelId: "grok-4.6",
      availableModels: [
        { modelId: "grok-4.6", name: "Grok 4.6", _meta: { reasoningEffort: "xhigh", reasoningEfforts: [{ id: "xhigh" }, { id: "high" }] } },
        { modelId: "grok-4.5", name: "Grok 4.5", _meta: { reasoningEffort: "high", reasoningEfforts: [{ id: "high" }, { id: "medium" }] } }
      ]
    }
  });
  const requests = [];
  agent.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "session/set_model") return { _meta: { model: { Ok: params.modelId } } };
    return {};
  };
  await agent.configure({ model: "grok-4.5", reasoning_effort: "medium" });
  assert.equal(agent.model, "grok-4.5");
  assert.equal(agent.reasoningEffort, "medium");
  assert.equal(requests[0].method, "session/set_model");
  assert.equal(requests[0].params._meta.reasoningEffort, "medium");
  await assert.rejects(agent.configure({ model: "unknown" }), /not advertised/);

  agent.status = "running";
  agent.handleAgentRequest({ id: 99, method: "x.ai/exit_plan_mode", params: { planContent: "Approved-looking plan" } });
  assert.equal(agent.status, "awaiting_plan_approval");
  assert.equal(agent.planApproval.plan_content, "Approved-looking plan");
  const approvalProgress = progressSnapshot(agent, agent.revision - 1);
  assert.equal(approvalProgress.action_required, "plan_approval");
  assert.equal(approvalProgress.pending_plan_approval.plan_content, "Approved-looking plan");
  agent.close();
});

test("interactive handoff command quotes paths and keeps the prompt out of the command", () => {
  const command = buildInteractiveCommand({
    binary: "/tmp/Grok Build/grok",
    cwd: "/tmp/project's files",
    promptFile: "/tmp/handoff prompt/prompt.txt",
    promptDir: "/tmp/handoff prompt",
    accessMode: "isolated_worktree",
    model: "grok-test",
    worktreeName: "grok-handoff-test"
  });
  assert(command.includes("cd '/tmp/project'\"'\"'s files'"));
  assert(command.includes("--worktree='grok-handoff-test'"));
  assert(command.includes("--permission-mode acceptEdits"));
  assert(command.includes('"$grok_handoff_prompt"'));
  assert(!command.includes("secret task body"));
  assert.equal(appleScriptString('say "hello" \\ path'), 'say \\"hello\\" \\\\ path');
});

test("visible progress has revisions, bounded previews, and waitable updates", async () => {
  const agent = new GrokAgent({
    cwd: tmpdir(),
    mode: "readonly",
    role: "test",
    model: "test-model",
    timeoutSeconds: 60
  });
  agent.status = "running";
  agent.consumeUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "Public progress" } });
  const first = agent.summary(false);
  assert(first.revision > 0);
  assert.equal(first.public_response_preview, "Public progress");
  const compact = progressSnapshot(agent, 0);
  assert.equal(compact.changed, true);
  assert.equal(compact.public_response_preview, "Public progress");
  assert.equal(compact.response_chars, "Public progress".length);

  agent.consumeUpdate({ sessionUpdate: "agent_thought_chunk", content: { text: "private" } });
  assert.equal(agent.revision, first.revision);
  assert(!agent.summary(false).public_response_preview.includes("private"));

  const waiting = waitForRevision(agent, first.revision, 1);
  setTimeout(() => agent.consumeUpdate({ sessionUpdate: "tool_call", title: "Inspect files", status: "in_progress" }), 10);
  await waiting;
  const second = agent.summary(false);
  assert(second.revision > first.revision);
  assert.equal(second.recent_tools.at(-1).title, "Inspect files");
  assert.equal(second.recent_tools.at(-1).revision, second.revision);
  assert(second.recent_tools.at(-1).at);
  const delta = progressSnapshot(agent, first.revision);
  assert.equal(delta.recent_tools.length, 1);
  assert.equal(delta.recent_tools[0].title, "Inspect files");
  assert.equal(delta.action_required, null);
});

test("linked worktree guard accepts a symlinked root and rejects a primary checkout", () => {
  const base = mkdtempSync(join(tmpdir(), "grok-subagent-worktree-"));
  const repo = join(base, "repo");
  const worktree = join(base, "worktree");
  const alias = join(base, "worktree-alias");

  try {
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    execFileSync("git", ["-C", repo, "add", "seed.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "seed"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "test-worktree", worktree], { stdio: "ignore" });
    symlinkSync(worktree, alias, "dir");

    assert.equal(assertLinkedWorktree(alias), realpathSync(worktree));
    assert.throws(() => assertLinkedWorktree(repo), /Primary checkouts are rejected/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cancellation settles back to idle and permits a follow-up", async () => {
  const agent = new GrokAgent({
    cwd: tmpdir(),
    mode: "readonly",
    role: "test",
    model: "test-model",
    timeoutSeconds: 60
  });
  agent.sessionId = "session-test";
  agent.status = "idle";
  const writes = [];
  agent.write = message => writes.push(message);

  let resolvePrompt;
  agent.request = () => new Promise(resolve => { resolvePrompt = resolve; });

  const firstTurn = agent.runTurn("first");
  assert.equal(agent.status, "running");
  assert.equal(agent.cancel(), true);
  assert.equal(agent.status, "cancelling");
  assert.equal(writes[0].method, "session/cancel");

  resolvePrompt({ stopReason: "cancelled" });
  await firstTurn;
  assert.equal(agent.status, "idle");

  agent.request = async () => ({ stopReason: "end_turn" });
  await agent.runTurn("follow-up");
  assert.equal(agent.status, "completed");
  agent.close();
});

test("failure terminates the child process without hiding the error", () => {
  const agent = new GrokAgent({
    cwd: tmpdir(),
    mode: "readonly",
    role: "test",
    model: "test-model",
    timeoutSeconds: 60
  });
  const signals = [];
  agent.proc = {
    killed: false,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(signal);
      this.signalCode = signal;
      return true;
    }
  };

  agent.fail(new Error("token=super-secret"));
  assert.equal(agent.status, "failed");
  assert.match(agent.error, /\[REDACTED\]/);
  assert(!agent.error.includes("super-secret"));
  assert.deepEqual(signals, ["SIGTERM"]);
  const originalError = agent.error;
  agent.onExit(null, "SIGTERM");
  assert.equal(agent.error, originalError);
});

test("search tools are advertised and the bridge script is present", () => {
  const byName = Object.fromEntries(TOOL_DEFINITIONS.map(tool => [tool.name, tool]));
  assert(byName.grok_search);
  assert(byName.grok_search_list);
  assert(byName.grok_search_show);
  assert.equal(byName.grok_search.annotations.openWorldHint, true);
  assert.equal(byName.grok_search.inputSchema.required.includes("query"), true);
  assert.deepEqual(byName.grok_search.inputSchema.properties.platform.enum, ["auto", "x", "reddit", "web"]);
  assert.deepEqual(byName.grok_search.inputSchema.properties.depth.enum, ["quick", "deep"]);
  const script = searchScriptPath();
  assert.match(script, /run_search\.py$/);
  assert(statSync(script).isFile());
});
