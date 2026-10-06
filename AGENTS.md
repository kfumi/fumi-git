# FumiGit — Agent 指南

## Agent skills

### Issue tracker

本地 markdown：spec 与工单以文件形式存于 `.scratch/<feature-slug>/`。See `docs/agents/issue-tracker.md`.

### Triage labels

默认五角色词汇（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`），在本地跟踪器中体现为文件顶部 `Status:` 行。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：根 `CONTEXT.md` + `docs/adr/`（按需惰性创建）。See `docs/agents/domain.md`.

## 项目速览

- 面向开发者的开源 Git 可视化客户端；**提交图谱是主角**，其它功能围绕它组织。
- Tauri 2（Rust 后端 + React 19 前端）；**git CLI 是唯一 Git 后端**（spawn + porcelain 解析，禁止引入 libgit2/gitoxide 作为行为源）。
- 首发平台 Windows；代码保持平台中立（不写死路径分隔符与平台专属 API）。
- 设计令牌与布局定稿：`docs/design/ui-spec.md`（变体 A 三栏工作台，2026-10 定稿）。
- 命名：目录/仓库 `fumi-git`，应用名 `FumiGit`，Rust crate `fumi_git`，identifier `com.fumigit.app`。
