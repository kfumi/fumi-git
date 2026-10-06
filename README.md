# FumiGit

面向开发者的开源 Git 可视化管理工具。**提交图谱是主角**：图形是第一操作面，其它功能围绕它组织。

- 形态：Tauri 2 桌面应用（Rust 后端 + React 前端）
- Git 接入：git CLI 唯一后端（spawn + porcelain 解析），行为与真 Git 100% 一致
- 首发：Windows（架构保持跨平台）
- 许可：Apache-2.0

## 开发

```bash
pnpm install
pnpm tauri dev      # 开发运行
pnpm tauri build    # 打包
```

## 文档

- [UI 设计规范](docs/design/ui-spec.md) — 布局、主题令牌、图谱配色（2026-10 定稿）
- UI 原型全量归档：分支 `prototype/ui-variants`

## 路线

v0.1 最小闭环：仓库列表 → 提交图谱 → commit 详情/diff → stage/unstage/commit → push/pull/fetch。
