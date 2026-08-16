# Security policy

## Supported versions

Security fixes are applied to the latest release. This project is currently pre-1.0, so interfaces may change between minor releases.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not open a public issue containing credentials, authentication files, exploitable payloads, or private source code.

Include the affected version, operating system, Grok CLI version, reproduction steps, expected boundary, and observed behavior. Use synthetic secrets and a disposable repository whenever possible.

## Trust boundaries

This plugin does not make Grok local or offline. Grok Build may send prompts and file content to xAI according to the user's authentication method, plan, organization settings, and xAI policies. Review the current [Grok Build enterprise and data lifecycle documentation](https://docs.x.ai/build/enterprise) before using private or regulated source code.

Do not delegate:

- API keys, access tokens, cookies, passwords, or private keys;
- production `.env` files or credential stores;
- regulated data unless your organization has approved the relevant xAI configuration;
- unrelated personal files;
- repositories whose contents you are not authorized to share with the configured service.

## Sandbox facts

The bridge currently uses Grok's documented profiles:

- `read-only`: project writes are blocked; `~/.grok` and temporary paths remain writable;
- `workspace`: writes are allowed in the current working directory, `~/.grok`, and temporary paths.

On Linux, Grok documents child-network blocking for read-only and strict profiles. On macOS, that child-network restriction is not currently enforced. Network isolation is therefore not a portable guarantee of this plugin.

Some sensitive directories are protected by Grok independently of these profiles, but users should not rely on deny lists as a substitute for careful scope selection.

Plan mode is not a filesystem sandbox. For a writing worker, the bridge runs planning in a separate Grok process under the `read-only` sandbox. Approving the plan requires a fresh `confirm_write_scope`, terminates the planning process, and starts a new `workspace` process in the already validated linked worktree. Requesting changes or cancelling never grants workspace access.

## Prompt injection

Repository files are untrusted model input. A malicious file can tell an agent to ignore instructions, expose data, or run commands. The worktree guard and sandbox reduce filesystem impact but do not prove that model output is correct or safe.

Codex should independently inspect relevant files, review every diff, and rerun tests. Agreement between Codex and Grok is not independent evidence if both consumed the same malicious repository content.

## Authentication handling

The bridge asks the official Grok CLI to use its advertised `cached_token` method. It never reads `~/.grok/auth.json`, prints tokens, or stores credentials. Grok child processes receive a minimal environment-variable allowlist instead of the bridge's complete environment. `XAI_API_KEY`, when present, is intentionally passed to the official CLI; additional variables require explicit opt-in through `GROK_PASSTHROUGH_ENV` and may be visible to Grok tools. The server also sanitizes common credential-shaped strings from retained errors and task prompts, but this is only a last-resort safeguard and not a complete secret scanner.

## Configuration and slash-command boundary

The plugin's persistent JSON contains only model/mode/profile defaults, the nested-subagent default, and a slash-command allowlist. It is written atomically with mode `0600` after `confirm_persist`; it contains no credentials and does not modify Grok's native config.

An advertised Grok command is not automatically authorized. `grok_command` also requires the command to be in the plugin allowlist. Credential/session commands, global auto-approval, native config/settings, hooks, sharing/export, memory, plugin/marketplace mutation, and command-creation workflows are hard-blocked and cannot be enabled through that JSON file. A writing session additionally requires write-scope confirmation for an allowed command.

Nested Grok subagents are disabled by default. Enabling them requires both `subagents_enabled: true` and `confirm_subagents: true`; nested work still inherits the parent Grok sandbox and does not expand Codex authorization.

## Native monitor boundary

A Codex-native Luna/Terra monitor is an orchestration worker, not a new authorization principal. It receives only the task scope the main Codex agent delegates and cannot broaden filesystem writes, enable nested Grok subagents, approve a Grok Plan, commit, merge, push, publish, or perform another external side effect without the authorization already required by the main workflow. Plan approval is always surfaced to the main Codex agent and user.

Progress reporting is intentionally public and bounded. `grok_progress` can expose lifecycle state, elapsed time, selected controls, public Plan content, tool titles/status, a short public-answer preview, and sanitized errors. The bridge discards Grok thought chunks; the monitor must not infer or fabricate hidden reasoning. If native Codex collaboration is unavailable, direct polling has the same data boundary.

## Dependency and process model

The MCP server uses only Node.js standard-library modules. Grok is launched with argument arrays rather than shell command interpolation. All child processes are terminated when the bridge shuts down, with a forced-kill fallback.

## Interactive handoff boundary

Interactive handoff is macOS-only and opens the official Grok TUI in a separate Terminal window. It is not an ACP-managed agent: Codex cannot observe its later prompts, approvals, filesystem activity, or completion state. Read-only handoffs use Grok's read-only sandbox. Writing handoffs start with `--worktree` and must originate at a Git repository root; the handoff prompt forbids commits, pushes, publication, and changes to other worktrees without fresh user authorization in that Terminal window.

The initial prompt is passed through a mode-0600 temporary file that the Terminal command removes before starting Grok. The prompt is sanitized but still leaves the machine for xAI under the user's Grok plan and policies. Do not use interactive handoff for secrets or unrelated personal data.

## Isolated search boundary

Search mode deliberately avoids launching Grok from the user's current project or Git worktree. The bridge creates a private research directory, copies only the local Grok auth file into a temporary home, and disables compatibility imports of Codex/Claude/Cursor skills, rules, agents, MCP servers, hooks, and sessions.

This reduces the chance that a research task packages or inspects the active codebase. It is not a local model and does not eliminate transmission of the user query or public search results to xAI. Treat returned web, X, and Reddit content as untrusted data.
