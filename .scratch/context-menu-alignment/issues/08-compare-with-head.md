# 08 — 与 HEAD 比较（`get_compare` + 右栏「比较」模式）

**What to build:** 提交右键菜单新增「与 HEAD 比较」（该提交即 HEAD 时禁用）。后端新增 `get_compare(base, head)`：两端各取一个 `CommitEntry`，加 `git diff --numstat <base>..<head>` 与 `git diff <base>..<head>`，返回 `CompareResult { base, head, files: FileStat[], patch: string | null }`（与提交详情复用同一套 `FileStat` 渲染，不复制解析逻辑）。前端 `repo.ts` 增 `compare: { base: string; head: string } | null`（进比较模式时 base = HEAD、head = 所选提交）；右栏 `RightPane` 的渲染优先级改为**冲突视图 → stash 查看 → 比较模式 → 提交详情 / 工作区 diff**；比较面板头部显示 `HEAD (<短号>) ↔ <短号> <subject>`，中部是文件列表，下部是统一 patch。patch 渲染若当前内联在 `CommitDetailPanel` 里，抽成可复用基元再共用（不允许复制粘贴一份）。退出条件：关闭右栏、切换中栏 tab、选中另一个提交——三者都退出比较模式。两端内容一致（patch 为空）时显示「与 HEAD 无差异」。

**Blocked by:** 02（菜单构建层）

**Status:** ready-for-agent

- [x] 右键非 HEAD 提交 →「与 HEAD 比较」→ 右栏切到比较模式，显示文件列表与统一 diff；该提交即 HEAD 时菜单项禁用
- [x] 比较面板底部不显示提交详情面板的 body/作者等无关块，只保留「文件列表 + patch」与本比较的头部
- [x] patch 为空时显示「与 HEAD 无差异」而不是空白面板
- [x] 关闭右栏、切到改动 tab、点选另一提交三种操作都退出比较模式（不会残留上一次的比较内容）
- [x] 比较模式下的文件列表沿用既有 `FileStat` 渲染（增删行数、二进制标记、重命名路径）
- [x] Rust 夹具测试覆盖 `get_compare`：有差异（断言 files 与 patch）、无差异（patch 为空）、非法哈希被拒
- [x] store 测试覆盖比较模式的进入与三种退出路径
- [x] `cargo test` 与 `pnpm test` 通过

## Comments

- 2026-10-11 完成（前端提交 995e553）。后端 `get_compare`（两端各取 `CommitEntry`，`--numstat` 出 files、统一 diff 出 patch，无差异时 `patch = null`）；另接受字面量 `HEAD` / `@`（`resolve_compare_ref`）——右栏「与 HEAD 比较」传的就是 `HEAD`，这样基准永远是调用瞬间的 HEAD，而不是前端某次刷新时的旧 id。
- 前端新增 `src/components/ComparePanel.tsx`：头部一行 `HEAD (<短号>) ↔ <短号> <subject>`、中部文件列表复用提交详情的 `FileRow`、下部 patch 复用 `DiffView`（没有第二份解析/着色实现），无差异显示「与 HEAD 无差异」；右栏渲染优先级 = 冲突视图 → stash 查看 → 比较模式 → 详情 / 工作区 diff；退出（关闭右栏 / 切中栏 tab / 选中另一提交）在 store 三处清空 `compare`。
- 验证：Rust `get_compare_files_patch_and_edge_cases`（含同提交无差异与非法哈希）与新增 `get_compare_accepts_literal_head`；store 侧进入成功（base=HEAD）、失败清空并报错、三种退出路径；menus 侧「与 HEAD 比较」在 HEAD 提交上禁用；`cargo test -- --test-threads=1` 52 passed / 1 ignored，`pnpm test` 134 passed。
- 评审整改：进入比较模式时同时清掉 `stashView`——右栏优先级里 stash 查看高于比较模式，留着会让「与 HEAD 比较」看起来毫无反应（点了没变化）；补一条 store 用例断言进入比较即收起 stash。
