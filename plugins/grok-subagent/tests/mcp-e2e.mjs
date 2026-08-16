import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpTestClient } from "./mcp-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const client = new McpTestClient(resolve(here, "../mcp-server/server.mjs"));
const target = resolve(process.env.GROK_E2E_CWD || process.cwd());
const expectedCwd = basename(target);
let agentId;
let planFixture;

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args[0]} failed`);
}

async function waitForStatus(expected, attempts = 12) {
  let result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await client.call("grok_result", { agent_id: agentId, wait_seconds: 30 });
    if (expected.includes(result.status)) return result;
  }
  return result;
}

try {
  await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });

  const capabilities = await client.call("grok_capabilities", { cwd: target });
  const selectedModel = capabilities.available_models.includes("grok-4.6")
    ? "grok-4.6"
    : capabilities.default_model;
  assert(selectedModel, "Grok did not advertise a default model");

  let guardWorked = false;
  try {
    await client.call("grok_spawn_worker", {
      task: "Do nothing.",
      worktree: target,
      confirm_write_scope: true
    });
  } catch (error) {
    guardWorked = /worktree|Git|checkout/i.test(error.message);
  }
  assert(guardWorked, "writing guard did not reject a non-linked-worktree target");

  const started = await client.call("grok_spawn_readonly", {
    cwd: target,
    role: "installation test reviewer",
    model: selectedModel,
    reasoning_effort: "low",
    session_mode: "agent",
    agent_profile: "explore",
    subagents_enabled: false,
    timeout_seconds: 240,
    task: `This is a read-only integration test. Inspect only the current directory. Reply with exactly two lines: GROK_SUBAGENT_OK and cwd=${expectedCwd}. Do not modify files and do not use subagents.`
  });
  agentId = started.agent_id;
  assert(Number.isInteger(started.revision));

  const progress = await client.call("grok_progress", {
    agent_id: agentId,
    after_revision: started.revision,
    wait_seconds: 30
  });
  assert(Number.isInteger(progress.revision));
  assert(progress.revision >= started.revision);
  assert.equal(typeof progress.changed, "boolean");
  assert.equal(typeof progress.elapsed_seconds, "number");
  assert.equal(typeof progress.public_response_preview, "string");
  assert(Array.isArray(progress.recent_tools));
  assert([null, "plan_approval", "inspect_error"].includes(progress.action_required));

  let result;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    result = await client.call("grok_result", { agent_id: agentId, wait_seconds: 30 });
    if (["completed", "failed", "cancelled"].includes(result.status)) break;
  }
  assert.equal(result.status, "completed", result.error || `unexpected status: ${result.status}`);
  assert.match(result.response, /GROK_SUBAGENT_OK/);
  assert(result.response.includes(`cwd=${expectedCwd}`));
  assert.equal(result.model, selectedModel);
  assert.equal(result.reasoning_effort, "low");
  assert.equal(result.agent_profile, "explore");
  assert.equal(result.subagents_enabled, false);

  const modelDescriptor = result.available_models.find(model => model.model_id === selectedModel);
  const nextEffort = modelDescriptor?.reasoning_efforts.some(effort => effort.id === "medium") ? "medium" : "low";
  const configured = await client.call("grok_session_configure", {
    agent_id: agentId,
    model: selectedModel,
    reasoning_effort: nextEffort,
    session_mode: "agent"
  });
  assert.equal(configured.reasoning_effort, nextEffort);

  const contextCommand = configured.available_commands.find(command => command.name === "context" && command.allowed);
  if (contextCommand) {
    await client.call("grok_command", { agent_id: agentId, command: "/context", timeout_seconds: 120 });
    const commandResult = await waitForStatus(["completed", "failed"], 4);
    assert.equal(commandResult.status, "completed", commandResult.error || "safe slash command failed");
  }
  await client.call("grok_close", { agent_id: agentId });
  agentId = null;

  planFixture = mkdtempSync(join(tmpdir(), "grok-subagent-plan-e2e-"));
  const repository = join(planFixture, "repository");
  const worktree = join(planFixture, "worker");
  mkdirSync(repository);
  git(["init", "-b", "main"], repository);
  git(["config", "user.name", "Grok Subagent E2E"], repository);
  git(["config", "user.email", "e2e@example.invalid"], repository);
  writeFileSync(join(repository, "README.md"), "# Plan fixture\n", "utf8");
  git(["add", "README.md"], repository);
  git(["commit", "-m", "test fixture"], repository);
  git(["worktree", "add", "-b", "grok-plan-e2e", worktree], repository);

  const planned = await client.call("grok_spawn_worker", {
    task: "Create plan-marker.txt at the worktree root with exactly the text PLAN_GATE_OK followed by one newline. First inspect the repository and produce a concrete plan. Do not edit any file until the plan is approved. When the plan is ready, request exit from Plan mode so Codex can approve it.",
    worktree,
    confirm_write_scope: true,
    model: selectedModel,
    reasoning_effort: "low",
    session_mode: "plan",
    subagents_enabled: false,
    timeout_seconds: 300
  });
  agentId = planned.agent_id;
  assert.equal(planned.runtime_access, "readonly");
  assert.equal(planned.phase, "planning");

  const pendingPlan = await waitForStatus(["awaiting_plan_approval", "failed", "completed"], 12);
  assert.equal(pendingPlan.status, "awaiting_plan_approval", pendingPlan.error || "Grok did not request plan approval");
  assert(pendingPlan.pending_plan_approval?.plan_content, "pending plan content was not exposed");
  assert.equal(existsSync(join(worktree, "plan-marker.txt")), false, "planning phase wrote to the worktree");

  const approved = await client.call("grok_plan_decide", {
    agent_id: agentId,
    action: "approve",
    confirm_write_scope: true
  });
  assert.equal(approved.runtime_access, "worker");
  assert.equal(approved.phase, "implementing");

  const implemented = await waitForStatus(["completed", "failed"], 12);
  assert.equal(implemented.status, "completed", implemented.error || "approved plan implementation failed");
  assert.equal(readFileSync(join(worktree, "plan-marker.txt"), "utf8"), "PLAN_GATE_OK\n");
  await client.call("grok_close", { agent_id: agentId });
  agentId = null;

  console.log("Grok ACP end-to-end test passed (controls, safe slash command, worker guard, and read-only Plan gate).\n" + result.response.trim());
} finally {
  if (agentId) {
    try { await client.call("grok_close", { agent_id: agentId }); } catch {}
  }
  client.close();
  if (planFixture) rmSync(planFixture, { recursive: true, force: true });
}
