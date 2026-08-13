# AGENTS.md

## 项目定位

Codex 插件：通过官方 Grok Build CLI，把 Grok 作为受控外部子 Agent，并支持仓库外的 Grok 原生 X/Web 搜索。Codex 负责编排与最终核验。

## 怎么跑起来

```bash
# 依赖：Node.js 22+、已登录的官方 Grok CLI（~/.grok/bin/grok 或 grok）
npm test
codex plugin marketplace add "$PWD"
codex plugin add grok-subagent@ms903-grok
# 安装后必须新建 Codex 任务，旧会话不会热加载 Skill/MCP
```

搜索 smoke（会消耗 Grok 额度）：

```bash
python3 plugins/grok-subagent/scripts/run_search.py run --platform x --depth quick --since 3d "..."
```

## 技术栈

- 无 npm 运行时依赖
- MCP stdio bridge：`plugins/grok-subagent/mcp-server/server.mjs`
- 官方 `grok agent stdio`（ACP）用于只读/写入/交互
- 隔离搜索桥：`plugins/grok-subagent/scripts/run_search.py`（改编自 sudoHG/codex-grok-search）

## 目录与约定

- 插件根：`plugins/grok-subagent/`
- Skill：`plugins/grok-subagent/skills/grok-subagent/SKILL.md`
- 中文 README 是默认入口；英文见 `README.en.md`；`README.zh-CN.md` 仅为迁移跳转
- 用户可见行为变更时同步更新 `README.md`、`README.en.md`、`CHANGELOG.md`、`ARCHITECTURE.md`、`SECURITY.md`
- 写入模式只允许 linked Git worktree（`.git` 为文件），禁止主检出
- 写入 Plan 必须先用独立只读进程规划，批准后才重启为 workspace 进程
- Grok 子 Agent 默认关闭；启用必须同时传 `subagents_enabled` 和 `confirm_subagents`
- 插件配置只写 `${XDG_CONFIG_HOME:-~/.config}/grok-subagent/config.json`，禁止改写 Grok 原生 config
- 搜索模式禁止进入当前仓库 cwd；结果缓存在 `~/.cache/grok-subagent/search-runs`
- 不要提交 `~/.grok/auth.json`、token、私有 prompt 或含真实密钥的测试仓

## 当前状态与下一步

- 现役开发版本：`0.5.0`，控制面包含模型、推理深度、Agent/Plan、profile、子 Agent、配置和安全 `/xxxx`
- marketplace：`ms903-grok`；插件名：`grok-subagent`
- 本地插件缓存安装后位于 `~/.codex/plugins/cache/ms903-grok/grok-subagent/0.5.0`
- 此 fork 上游为 `Walvez/grok-subagent`；不要改写或压平原始历史
- 新任务中优先：项目审查用 `grok_spawn_readonly`；X/Reddit/实时公开研究用 `grok_search`
