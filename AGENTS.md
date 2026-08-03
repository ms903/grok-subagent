# AGENTS.md

## 项目定位

Codex 插件：通过官方 Grok Build CLI，把 Grok 作为受控外部子 Agent，并支持仓库外的 Grok 原生 X/Web 搜索。Codex 负责编排与最终核验。

## 怎么跑起来

```bash
# 依赖：Node.js 22+、已登录的官方 Grok CLI（~/.grok/bin/grok 或 grok）
npm test
codex plugin marketplace add "$PWD"
codex plugin add grok-subagent@walvez-grok
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
- 搜索模式禁止进入当前仓库 cwd；结果缓存在 `~/.cache/grok-subagent/search-runs`
- 不要提交 `~/.grok/auth.json`、token、私有 prompt 或含真实密钥的测试仓

## 当前状态与下一步

- 现役版本：`0.4.0`，`main` 已含隔离搜索工具
- 本地插件缓存：`~/.codex/plugins/cache/walvez-grok/grok-subagent/0.4.0`
- 公开 GitHub Release 仍停在 `v0.3.1`；若要对外安装路径解析到 0.4.0，需要补 tag/Release
- 新任务中优先：项目审查用 `grok_spawn_readonly`；X/Reddit/实时公开研究用 `grok_search`
