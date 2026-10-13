# 08 — 与 HEAD 比较（`get_compare` + 右栏「比较」模式）

**What to build:** 提交右键菜单新增「与 HEAD 比较」（该提交即 HEAD 时禁用）。后端新增 `get_compare(base, head)`：两端各取一个 `CommitEntry`，加 `git diff --numstat <base>..<head>` 与 `git diff <base>..<head>`，返回 `CompareResult { base, head, files: FileStat[], patch: string | null }`（与提交详情复用同一套 `FileStat` 渲染，不复制解析逻辑）。前端 `repo.ts` 增 `compare: { base: string; head: string } | null`（进比较模式时 base = HEAD、head = 所选提交）；右栏 `RightPane` 的渲染优先级改为**冲突视图 → stash 查看 → 比较模式 → 提交详情 / 工作区 diff**；比较面板头部显示 `HEAD (<短号>) ↔ <短号> <subject>`，中部是文件列表，下部是统一 patch。patch 渲染若当前内联在 `CommitDetailPanel` 里，抽成可复用基元再共用（不允许复制粘贴一份）。退出条件：关闭右栏、切换中栏 tab、选中另一个提交——三者都退出比较模式。两端内容一致（patch 为空）时显示「与 HEAD 无差异」。

**Blocked by:** 02（菜单构建层）

**Status:** ready-for-agent

- [ ] 右键非 HEAD 提交 →「与 HEAD 比较」→ 右栏切到比较模式，显示文件列表与统一 diff；该提交即 HEAD 时菜单项禁用
- [ ] 比较面板底部不显示提交详情面板的 body/作者等无关块，只保留「文件列表 + patch」与本比较的头部
- [ ] patch 为空时显示「与 HEAD 无差异」而不是空白面板
- [ ] 关闭右栏、切到改动 tab、点选另一提交三种操作都退出比较模式（不会残留上一次的比较内容）
- [ ] 比较模式下的文件列表沿用既有 `FileStat` 渲染（增删行数、二进制标记、重命名路径）
- [ ] Rust 夹具测试覆盖 `get_compare`：有差异（断言 files 与 patch）、无差异（patch 为空）、非法哈希被拒
- [ ] store 测试覆盖比较模式的进入与三种退出路径
- [ ] `cargo test` 与 `pnpm test` 通过
