# Changelog

All notable changes to this project will be documented here.

## 0.6.0 - 2026-08-16

### Added

- Added `grok_progress`, a compact revision-based long-poll endpoint for public lifecycle, Plan, tool, preview, and action-required updates.
- Added a native Codex monitor workflow: Luna/low handles routine Grok waiting and progress relay, while Terra/medium is reserved for complex plan interpretation, steering, or multi-result synthesis.
- Added deterministic and authenticated E2E coverage for the compact progress protocol.

### Changed

- Long Grok tasks now prefer a native Codex monitor so the main agent remains responsive; direct polling remains the compatibility fallback.
- Plan approval and every write-scope decision remain owned by the main Codex agent and user.

### Security

- Progress snapshots remain bounded to public response text, Plan content, tool metadata, lifecycle state, and sanitized errors; private thought chunks are never forwarded.
- Native monitor agents cannot expand write scope, approve Plans, enable nested Grok subagents, or publish changes on their own.

## 0.5.0 - 2026-08-14

### Added

- Added per-agent model, reasoning-effort, Agent/Plan mode, named agent-profile, and nested-subagent controls.
- Added `grok_capabilities`, `grok_session_configure`, `grok_plan_decide`, and allowlisted `grok_command` MCP tools.
- Added explicit non-secret plugin defaults through `grok_config_get` and `grok_config_set`.
- Added model/effort/mode/profile controls to interactive handoff.

### Security

- Writing Plan sessions now plan in a separate OS-enforced read-only process and start a workspace process only after explicit approval and renewed write-scope confirmation.
- Nested Grok subagents default to disabled and require a second explicit confirmation to enable.
- Persistent plugin configuration uses a strict schema, atomic replacement, and mode `0600`, and never edits Grok's native config.
- Slash commands require both ACP advertisement and a local allowlist; commands affecting credentials, approval policy, hooks, sharing, memory, plugins, or native settings are permanently blocked.

### Changed

- Changed the fork marketplace ID to `ms903-grok` while retaining the `grok-subagent` plugin name.
- Updated package and plugin metadata for the `ms903/grok-subagent` fork.

## 0.4.0 - 2026-08-03

### Added

- Added isolated `grok_search`, `grok_search_list`, and `grok_search_show` tools for Grok-native X, Reddit, and public-web research outside the current repository.
- Bundled a repository-free Grok search bridge adapted from the MIT-licensed `sudoHG/codex-grok-search` project.
- Extended the orchestration skill so current X/Twitter and Reddit research prefers `grok_search` before ordinary web search or project-scoped Grok agents.

### Security

- Search runs use a private cache under `~/.cache/grok-subagent/search-runs`, temporary HOME/GROK_HOME isolation, and only `x_search`, `web_search`, and `web_fetch`.
- Search mode still sends queries and retrieved public content to xAI; it reduces local repository exposure rather than claiming zero upload.

## 0.3.0 - 2026-07-18

### Added

- Added a macOS-only `grok_handoff_interactive` tool that opens the official Grok TUI in a new Terminal window with a Codex-authored task prompt.
- Added read-only and isolated-worktree access modes for user-supervised interactive handoffs.

### Security

- Interactive implementation handoffs cannot write directly to the primary checkout and do not authorize commits, pushes, publication, or changes outside the Grok-created worktree.
- Initial handoff prompts use mode-0600 temporary files and are removed by the launched Terminal command before Grok starts.

## 0.2.0 - 2026-07-18

### Added

- Added monotonic progress revisions, elapsed time, timestamped tool events, and a bounded public-response preview to Grok agent status.
- Added optional long-polling to `grok_status` through `after_revision` and `wait_seconds`.
- Made the orchestration skill relay material Grok progress and provide a user-visible heartbeat at least once per minute.

### Security

- Kept visible progress limited to public answer chunks, plan entries, tool metadata, and lifecycle state; private chain-of-thought remains discarded.

## 0.1.1 - 2026-07-17

### Fixed

- Canonicalized project and worktree paths so symlinked roots, including macOS `/tmp`, are handled correctly.
- Made cancellation settle back to an idle session and terminated failed or timed-out Grok processes.
- Corrected MCP tool annotations and protocol-version negotiation.
- Required explicit write-scope confirmation for writing-agent follow-ups.
- Limited Grok child processes to a documented environment-variable allowlist.
- Added deterministic tests for worktree guards, lifecycle behavior, environment filtering, redaction, and protocol metadata.

### Changed

- Raised the minimum supported Node.js version to 22 and added Node.js 22/24 CI coverage.

## 0.1.0 - 2026-07-17

### Added

- Codex plugin and `$grok-subagent` orchestration skill.
- Dependency-free MCP-to-ACP bridge for the official Grok Build CLI.
- Read-only investigation mode.
- Linked-Git-worktree writing mode with explicit authorization guard.
- Agent status, result, follow-up, cancellation, close, and list tools.
- Bounded event retention and credential-shaped text sanitization.
- MCP smoke tests, authenticated end-to-end test, repository validation, and CI.
