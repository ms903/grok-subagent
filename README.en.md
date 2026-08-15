# Grok Subagent for Codex

[![CI](https://github.com/ms903/grok-subagent/actions/workflows/ci.yml/badge.svg)](https://github.com/ms903/grok-subagent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Codex Plugin](https://img.shields.io/badge/Codex-plugin-111827)](plugins/grok-subagent/.codex-plugin/plugin.json)

Let Codex call the official Grok Build CLI as a controlled external subagent while Codex remains responsible for orchestration, decisions, and final verification.

This release also bridges isolated Grok-native X/Reddit/web search through `grok_search`.

[简体中文](README.md) · [Architecture](ARCHITECTURE.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

> Community project. Not affiliated with, endorsed by, or sponsored by OpenAI or xAI. Grok and Grok Build are trademarks of xAI; Codex is a product of OpenAI.

Core capabilities:

- **Independent cross-model review:** Grok investigates, reviews code, or challenges a plan; Codex verifies the findings.
- **Managed sessions:** inspect status, continue a conversation, retrieve results, cancel, and close instead of copying one-off answers.
- **Responsive native monitoring:** long tasks default to a low-latency Luna subagent that calls and monitors Grok while the main Codex agent remains responsive; Terra is reserved for complex plan interpretation or synthesis.
- **Full control surface:** select the Grok model, reasoning effort, Agent/Plan session mode, and built-in agent profile per task.
- **Gated plans:** writing tasks plan in an OS-enforced read-only process and start an isolated worktree worker only after approval.
- **Safe defaults:** investigations are read-only; writing requires explicit authorization and an isolated linked Git worktree.

## 60-second quick start

### 1. Install and authenticate Grok Build

You need Node.js 22+, a recent Codex CLI/Desktop build with plugin support, and the official Grok Build CLI.

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok
```

### 2. Install the Codex plugin

```bash
codex plugin marketplace add ms903/grok-subagent
codex plugin add grok-subagent@ms903-grok
```

Start a **new Codex task** after installation so the skill and MCP tools are loaded into the new task context.

### 3. Run the first read-only delegation

Tell Codex:

```text
Use Grok as a read-only subagent to review this project independently.
Return the three most important risks with file-and-line evidence.
Verify the findings before reporting them to me.
```

On success, Codex starts a Grok agent, receives an agent ID, and reads the result when Grok completes. Project files remain unchanged.

## When to use it

| Good fit | Probably unnecessary |
| --- | --- |
| You want an independent review from another model provider | You only need a one-off Grok answer |
| You are reviewing high-risk authentication, payment, permission, or concurrency code | You need a many-provider dashboard and visualization layer |
| You want a migration or implementation plan challenged from the opposing side | Your environment cannot send relevant code or context to xAI |
| You want a second implementation inside an isolated worktree | You require agent sessions to survive Codex/MCP restarts automatically |

## How it works

```mermaid
flowchart LR
    U["User"] --> C["Codex orchestrator"]
    C --> N["Native Luna / Terra monitor"]
    C -. "quick call / fallback" .-> S["Grok Subagent Skill"]
    N --> S
    S --> M["Local MCP bridge"]
    M --> A["Official Grok ACP: grok agent stdio"]
    A --> R["Read-only project"]
    A --> W["Isolated Git worktree"]
    A --> X["xAI / Grok service"]
    M --> N
    N --> C
    C --> V["Codex verification and final result"]
```

The bridge is an orchestration adapter, not another full coding-agent framework. The official Grok Build runtime still owns authentication, inference, file and terminal tools, and model sessions. Codex decides what to delegate and verifies the outcome. See [ARCHITECTURE.md](ARCHITECTURE.md) for protocol and trust boundaries.

## Why this architecture

| Approach | Main trade-off |
| --- | --- |
| Copy and paste between apps | Manual context transfer, no lifecycle control, easy to lose evidence |
| Browser automation | Fragile selectors and session handling; awkward streaming and cancellation |
| Unofficial consumer-session connector | Depends on private interfaces or credentials with uncertain compatibility and security boundaries |
| Raw xAI API wrapper | Rebuilds tools, sessions, permissions, and sandboxing, and may require separate API setup and billing |
| Native Codex subagents | Tighter integration, but generally within the same platform and model family |
| **This plugin: official Grok CLI + ACP + MCP** | Keeps the supported Grok agent runtime and adds a narrow, auditable Codex control layer |

This plugin does not replace native Codex subagents; it composes them. A native Luna or Terra subagent handles lightweight monitoring and progress relay, Grok performs independent investigation or isolated implementation as an external model, and the main Codex agent keeps orchestrating and verifying. The plugin skill creates native monitors at the Codex layer. The MCP bridge itself only manages Grok ACP processes and does not replace the Codex harness.

### Real-time X / community search

```text
Use Grok to find the most discussed X posts about OpenCodex from the past 7 days,
include direct links, and prefer high-engagement original posts over ordinary web mirrors.
```

`grok_search` starts Grok 4.5 outside the current repository with only `x_search`, `web_search`, and `web_fetch`, then returns Grok's complete answer to Codex.

## Common workflows

### Independent investigation

```text
Use Grok as a read-only subagent to inspect this repository's authentication flow.
Ask it for file-and-line evidence. You remain responsible for the final diagnosis.
```

### Second-opinion code review

```text
Have Grok independently review the current diff for correctness, security,
and concurrency issues. Report only findings you can verify yourself.
```

### Plan red-team

```text
Ask Grok to challenge this migration plan. Focus on rollback gaps, data-loss risks,
unsupported assumptions, and missing tests. Then prioritize the strongest objections.
```

### Isolated implementation

```text
Create an isolated linked Git worktree and let Grok implement the parser change there.
Do not merge, commit, or push. Review the diff and run tests yourself afterward.
```

Writing mode requires explicit user authorization. The plugin rejects the primary checkout and any directory whose `.git` entry is not a linked-worktree file. Follow-ups to a writing agent must confirm that they remain within the same authorized write scope.

### Select model, effort, agent, and Plan mode

Tell Codex, for example:

```text
Call Grok with grok-4.6, high reasoning effort, and the plan profile.
Inspect this project in Plan mode and show me the implementation plan.
Do not enable Grok subagents or write to the worktree until I approve it.
```

`grok_capabilities` discovers models and built-in agent profiles from the current Grok installation. Between turns, `grok_session_configure` changes the model, reasoning effort, or Agent/Plan mode through ACP. A writing worker started with `session_mode: "plan"` plans in a separate `read-only` process. Only `grok_plan_decide` with `approve` and a fresh write-scope confirmation starts the `workspace` process. Plan feedback never grants write access.

Nested Grok subagents are disabled by default. Enabling them requires both the option and an explicit confirmation; this is independent of selecting an `agent_profile`.

## Security model at a glance

| Mode | Filesystem access | Startup condition | Responsibility afterward |
| --- | --- | --- | --- |
| Read-only investigation | Grok `read-only` sandbox | Any readable absolute directory | Codex verifies files, commands, and conclusions |
| Writing worker | Grok `workspace` sandbox, limited to a linked worktree | Explicit user authorization plus bridge worktree validation | Codex inspects the diff and reruns tests |
| Plan then write | `read-only` planning; `workspace` only after approval | Linked worktree + startup authorization + approval-time reconfirmation | Codex presents the plan, then reviews the implementation diff |

Important boundaries:

- Grok is an external model. Files it reads or context it receives may be sent to xAI according to your Grok/xAI plan and policies.
- Authentication is owned by the official Grok CLI. The plugin does not persist or independently manage credentials, and it does not expose them to Codex. When `XAI_API_KEY` is present, the bridge only passes it to the official Grok CLI child process.
- Never delegate secrets, tokens, production `.env` files, SSH private keys, or unrelated personal data.
- The bridge filters the child environment, but explicitly passed variables and `XAI_API_KEY` remain visible to the official CLI process.
- Read-only mode prevents project writes, but Grok may still write under `~/.grok` and temporary directories. On macOS, do not treat it as an offline network boundary.
- Model agreement is not verification, and repository content may prompt-inject either model.
- The bridge discards thought chunks and retains only bounded public text, plan entries, tool titles/status, and sanitized errors in memory.

Read [SECURITY.md](SECURITY.md) before using the plugin on private code.

## Management tools

| Tool | Purpose | Filesystem mode |
| --- | --- | --- |
| `grok_spawn_readonly` | Start an independent investigation, review, or plan analysis | Grok `read-only` sandbox |
| `grok_spawn_worker` | Implement inside an approved linked worktree | Grok `workspace` sandbox + bridge guard |
| `grok_handoff_interactive` | Open an interactive Grok TUI in a new macOS Terminal window and stop Codex supervision after prompt handoff | Read-only or a Grok-created isolated worktree |
| `grok_search` | Run Grok-native X/Web research outside the current repository | Private research directory |
| `grok_search_list` / `grok_search_show` | List or read retained search answers | Read-only |
| `grok_capabilities` | Inspect Grok version, models, agent profiles, config sources, and plugin defaults | Read-only |
| `grok_session_configure` | Change model, reasoning effort, or Agent/Plan mode between turns | ACP control operation |
| `grok_plan_decide` | Approve, revise, or cancel a plan; worker approval starts isolated implementation | Approval control operation |
| `grok_command` | Run a Grok `/xxxx` command only when both advertised and allowlisted | Allowlist-controlled |
| `grok_config_get` / `grok_config_set` | Read or explicitly persist non-secret plugin defaults atomically | Plugin config file |
| `grok_progress` | Return a compact public progress delta for native monitor subagents, with up to 30 seconds of long polling | Read-only |
| `grok_status` | Read lifecycle, elapsed time, plan, recent tool activity, and a public-response preview; optionally wait for a newer revision | Read-only |
| `grok_result` | Read the public answer, optionally waiting briefly | Read-only |
| `grok_send` | Send a focused follow-up; writing sessions require renewed scope confirmation | Inherits session mode |
| `grok_cancel` | Cancel the active turn | Control operation |
| `grok_close` | Terminate and remove the Grok process | Control operation |
| `grok_list` | List agents owned by the current bridge | Read-only |

The bridge permits at most three open Grok processes. The skill recommends one by default and two only for genuinely independent work.

### Interactive handoff mode

When the user explicitly asks Codex to hand a task fully to Grok and interact with it directly, Codex turns the goal, scope, known context, completion criteria, and restrictions into a self-contained prompt. `grok_handoff_interactive` then opens a new macOS Terminal window. The Grok TUI is user-supervised from that point onward: Codex does not poll it, close it automatically, or pretend to know its current state.

Read-only work uses Grok's `read-only` sandbox. Implementation work uses `--worktree` to create an isolated worktree and accepts file edits there, while commits, pushes, publication, and other external actions still require explicit authorization in the Grok window. The user can return to Codex afterward for independent diff, test, and claim verification.

### How visible progress works

Long Grok inference, review, and search tasks default to a native Codex monitor subagent. Routine startup, waiting, progress relay, and result transport use `gpt-5.6-luna` with low reasoning. The skill uses `gpt-5.6-terra` with medium reasoning only when the monitor must interpret a complex plan, substantively steer Grok, or synthesize several results. An explicit user model choice wins. If native collaboration is unavailable, the skill falls back to direct polling without failing the Grok task.

The monitor calls `grok_progress` with a revision cursor for incremental waits of up to 30 seconds. It sends the main Codex agent a native-mailbox update on startup, material plan/tool/state/public-answer changes, completion, and at least one heartbeat every 60 seconds. The main agent relays concise progress in the Codex task while it remains free to verify work or answer the user. On `action_required: "plan_approval"`, the monitor reports the public plan and pauses; only the main Codex agent and user can decide.

The bridge discards private thought chunks and exposes only lifecycle, elapsed time, plan entries, tool titles/status, bounded public-answer previews, and sanitized errors. Because isolated `grok_search` is synchronous, its monitor can currently expose only start, heartbeat, and completion rather than internal search-tool steps.

## Requirements and compatibility

- macOS, Linux, or WSL;
- Node.js 22 or newer;
- a recent Codex CLI/Desktop build with plugin support;
- native Luna/Terra monitoring requires a Codex build with subagent collaboration; direct polling remains the fallback;
- the official Grok Build CLI, authenticated locally;
- Git when using writing workers.

Last verified environment (2026-08-16): Linux, Grok CLI `1.0.3`, and plugin `0.6.0`. A capability probe discovered `grok-4.6` (default) and `grok-4.5`. A native Luna subagent then started and monitored a real `grok-4.6`/low/read-only task against a synthetic directory, relayed revision progress and the result, and closed the session. The 0.6.0 deterministic suite covers the new `grok_progress` protocol. Authenticated E2E also passed against a temporary directory containing only synthetic data and covered model/effort/profile control, a safe slash command, and the complete read-only Plan-to-approved-temporary-worktree flow. E2E sends relevant content from the selected test directory to xAI, so testing a real repository still requires explicit authorization. These are observations from that installation, not a hard-coded support list; use `grok_capabilities` and each session descriptor as the source of truth. Authentication remains owned by the official CLI.

Official references: [Grok Build overview](https://docs.x.ai/build/overview), [Headless & ACP](https://docs.x.ai/build/cli/headless-scripting), and [CLI reference](https://docs.x.ai/build/cli/reference).

## Configuration

The plugin has no npm runtime dependencies and stores no credentials. Non-secret defaults live at `${XDG_CONFIG_HOME:-~/.config}/grok-subagent/config.json`; writes are atomic with mode `0600`, and the plugin never edits Grok's native `~/.grok/config.toml`.

Precedence is: explicit tool arguments > plugin config > `GROK_MODEL` (model only) > the Grok CLI default. The only persistent fields are `default_model`, `default_reasoning_effort`, `default_session_mode`, `default_agent_profile`, `default_subagents_enabled`, and `allowed_slash_commands`. `grok_config_set` requires `confirm_persist`.

| Variable | Meaning | Default |
| --- | --- | --- |
| `GROK_BIN` | Absolute path or command name for the official Grok CLI | `~/.grok/bin/grok`, then `grok` |
| `GROK_MODEL` | Model ID when no plugin default is configured | Let Grok select |
| `GROK_PASSTHROUGH_ENV` | Comma-separated extra environment-variable names to pass to Grok | unset |
| `GROK_SUBAGENT_CONFIG_FILE` | Override the plugin config path, primarily for tests or managed deployments | XDG `grok-subagent/config.json` |

The model can also be selected per agent. Grok receives a minimal system environment plus `XAI_API_KEY` when present. Other host variables are not inherited unless their names are explicitly listed in `GROK_PASSTHROUGH_ENV`.

## Local development and tests

```bash
git clone https://github.com/ms903/grok-subagent.git
cd grok-subagent
codex plugin marketplace add "$PWD"
codex plugin add grok-subagent@ms903-grok
```

Run the deterministic checks without installing project dependencies:

```bash
npm test
```

The authenticated end-to-end test consumes a small amount of Grok usage:

```bash
npm run test:e2e
```

Set `GROK_E2E_CWD=/absolute/project/path` to select another read-only target. The test also rejects a primary checkout and exercises the complete Plan approval gate in a temporary linked worktree.

Upgrade a Git marketplace snapshot with:

```bash
codex plugin marketplace upgrade ms903-grok
codex plugin add grok-subagent@ms903-grok
```

When switching from the Walvez upstream marketplace to this fork, migrate once:

```bash
codex plugin remove grok-subagent@walvez-grok
codex plugin marketplace remove walvez-grok
codex plugin marketplace add ms903/grok-subagent
codex plugin add grok-subagent@ms903-grok
```

Start a new Codex task after migration. Later releases can use the regular
upgrade commands above.

## Current limitations

- Agent lists are in memory and are not restored after the MCP bridge closes.
- Public answer text is bounded to prevent unbounded memory growth.
- The bridge does not merge, commit, push, or delete worktrees.
- Grok is an external ACP worker exposed through MCP, not a native Codex team subagent.
- The native monitor is a skill-level orchestration convention, not an MCP-server capability; older Codex builds fall back to direct polling.
- Grok CLI behavior, model names, and sandbox implementation may change. Pin or centrally manage Grok versions in sensitive environments.

## Upstream and maintenance

This fork continues from [`Walvez/grok-subagent`](https://github.com/Walvez/grok-subagent) and preserves its MIT license and history. `ms903-grok` is this fork's marketplace ID; the plugin name remains `grok-subagent`.

## Acknowledgements

The isolated search bridge is adapted from the MIT-licensed [`sudoHG/codex-grok-search`](https://github.com/sudoHG/codex-grok-search) project.

## License

MIT. See [LICENSE](LICENSE).
