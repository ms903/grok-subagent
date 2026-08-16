# Architecture

## Design goal

The bridge is intentionally an orchestrator adapter, not another coding-agent framework. Codex decides what to delegate and verifies the outcome. The official Grok Build process owns Grok-specific authentication, inference, tools, and session semantics.

## Protocol path

```text
Codex task
  -> native Codex Luna/Terra monitor (long task; optional)
  -> bundled grok-subagent skill
  -> MCP JSON-RPC over stdio
  -> mcp-server/server.mjs
  -> ACP JSON-RPC over stdio
  -> official `grok agent stdio`
  -> Grok/xAI service and local tools
```

The MCP server has no third-party runtime dependencies. Each external agent owns:

- one child `grok` process;
- one ACP `sessionId`;
- one active prompt turn at a time;
- bounded public answer text;
- recent plan and tool-status summaries;
- a monotonic progress revision, elapsed time, and bounded public-response preview;
- lifecycle state and sanitized errors.

## ACP lifecycle

1. Spawn Grok with `--no-auto-update`, the selected sandbox, optional model/reasoning effort/agent profile, the explicit nested-subagent policy, automatic approval, and `agent stdio`.
2. Send ACP `initialize` with protocol version 1.
3. Use the official `cached_token` authentication method when advertised. Other Grok-supported environment authentication remains owned by the CLI.
4. Create a session with `session/new`, the target directory, no nested MCP servers, and additional orchestration rules.
5. Send the task with `session/prompt`.
6. Consume `session/update` events. Keep public message chunks, plan entries, and bounded tool metadata; discard thought chunks.
7. Let `grok_progress` long-poll a compact, public progress delta for up to 30 seconds. Keep `grok_status` as the fuller diagnostic view.
8. Read the session's advertised models, reasoning efforts, modes, and slash commands. `session/set_model` and `session/set_mode` provide between-turn control without replacing the Codex harness.
9. Hold Grok's Plan exit request for a Codex/user decision instead of approving it automatically.
10. Keep the process alive for focused follow-ups until cancellation, close, or MCP shutdown.

The child process receives only a small system environment allowlist, supported Grok authentication variables, and variables explicitly named by the operator. Failed or timed-out sessions terminate their Grok process while retaining a bounded diagnostic summary.

## Native Codex monitor layer

The MCP server cannot create Codex-native subagents. Native monitoring is deliberately a skill-level orchestration policy:

1. For a long Grok task, the main Codex agent creates one bounded native monitor and gives it the absolute scope, Grok controls, safety boundary, and expected output.
2. `gpt-5.6-luna` with low reasoning handles routine start/wait/progress/result transport. `gpt-5.6-terra` with medium reasoning is reserved for complex plan interpretation, substantive steering, or multi-result synthesis.
3. The monitor starts exactly one Grok task, reports the agent ID immediately, and advances a `revision` cursor with `grok_progress`.
4. Material public changes and a maximum-60-second heartbeat travel through the native subagent mailbox, leaving the main Codex agent free to work or answer the user.
5. A Plan approval request returns to the main agent and user. The monitor never approves a plan or expands write scope.
6. If native collaboration or the requested native model is unavailable, the main agent uses the same `grok_progress` loop directly.

`grok_progress` returns lifecycle state, phase, elapsed time, selected controls, an action-required flag, bounded Plan content when approval is pending, at most five tool-event deltas, response length, a bounded public-answer preview, and sanitized errors. It never returns Grok thought chunks. Synchronous isolated search has no internal event stream, so a native monitor can only report search startup, heartbeat, and completion.

## Isolated search mode

`grok_search` is intentionally outside the managed ACP lifecycle. The bridge launches the official Grok CLI once with:

- a private run directory under `~/.cache/grok-subagent/search-runs`;
- temporary `HOME` / `GROK_HOME` values containing only a copied auth file and a minimal config;
- tools limited to `x_search`, `web_search`, and `web_fetch`;
- model pinned to `grok-4.5`;
- no MCP, memory, plan mode, or nested subagents.

The search bridge is adapted from the MIT-licensed `sudoHG/codex-grok-search` project and returns Grok's complete answer without content filtering. Codex remains responsible for framing the research task and synthesizing the final user-facing answer.

## Interactive handoff mode

`grok_handoff_interactive` is intentionally outside the managed ACP lifecycle. On macOS it writes the sanitized handoff prompt to a mode-0600 temporary file, opens a new Terminal window, reads and removes that file, and starts the official interactive Grok TUI. Read-only handoffs use the read-only sandbox. Writing handoffs require a Git repository root and ask Grok to create an isolated worktree.

The MCP call returns after Terminal opens. The bridge does not retain the TUI process, session ID, transcript, or completion state. The user owns interaction and lifecycle from that point and must return to Codex explicitly for independent verification.

## Read-only mode

`grok_spawn_readonly` starts Grok with `--sandbox read-only`. The bridge accepts any readable absolute directory. Grok's sandbox is the enforcement boundary; the prompt also states that the session must not modify project files.

## Writing mode

`grok_spawn_worker` requires all of the following before process startup:

1. `confirm_write_scope` is true after explicit user authorization;
2. the target is an absolute directory;
3. `git rev-parse --show-toplevel` resolves exactly to that directory;
4. `.git` is a file, which is the normal marker of a linked Git worktree.

The process then starts with `--sandbox workspace`. The bridge never creates commits, pushes, merges, cherry-picks, or removes the worktree.

### Two-process Plan gate

Grok's logical Plan mode is not treated as a filesystem boundary. A worker requested with `session_mode: "plan"` therefore uses two processes:

```text
linked worktree
  -> Grok process A: read-only sandbox + Plan mode
  -> pending plan approval in MCP
  -> approve + fresh confirm_write_scope
  -> terminate process A
  -> Grok process B: workspace sandbox + Agent mode
  -> prompt includes original task and approved plan
```

`request_changes` responds to the pending Grok Plan request, reasserts Plan mode, and sends the feedback in the same read-only process. `cancel` finishes without starting process B. Because ACP does not expose a portable session-clone primitive, implementation starts a new Grok session; the original task and approved public plan are carried forward explicitly.

## Model, effort, agent, and command controls

- Model IDs and reasoning-effort values come from each ACP `session/new` descriptor. The bridge validates changes against that descriptor and forwards them through `session/set_model` with Grok's `reasoningEffort` metadata.
- `agent_profile` is a named Grok CLI profile passed at process startup. It is separate from Agent/Plan session mode.
- Nested Grok subagents default to disabled (`--no-subagents`) and require an explicit confirmation to enable.
- `grok_command` accepts only commands both advertised by the current ACP session and present in the plugin allowlist. Commands that affect credentials, global approval, hooks, sharing/export, memory, plugins, or native configuration are permanently blocked.

## Plugin configuration

The bridge owns a narrow JSON config at `${XDG_CONFIG_HOME:-~/.config}/grok-subagent/config.json`; it never rewrites `~/.grok/config.toml`. `grok_config_set` validates a fixed schema, requires explicit persistence confirmation, writes a mode-0600 temporary file, then atomically renames it. No tokens, hook commands, inline agent definitions, or arbitrary native Grok keys are accepted.

Configuration precedence is explicit tool input, then plugin JSON, then `GROK_MODEL` for model selection, then Grok's own defaults.

## Why automatic Grok approval is used

ACP integrations cannot depend on an interactive terminal approval prompt. The bridge therefore launches Grok in automatic-approval mode only after selecting an OS sandbox. Permissions decide whether Grok asks; the sandbox decides what the process can actually write. Writing mode adds the worktree precondition so even an approved edit is separated from the primary checkout.

This is defense in depth, not a claim of perfect isolation. See [SECURITY.md](SECURITY.md).

## Resource bounds

- maximum three open Grok processes per bridge;
- 120,000 characters of retained public answer text per agent;
- 12,000 characters of retained stderr;
- 20 recent tool events;
- 30-minute maximum prompt timeout;
- 30-second maximum blocking result wait.
- 30-second maximum `grok_progress` long poll with at most five tool-event deltas per response.

Closing the MCP server terminates all child Grok processes.
