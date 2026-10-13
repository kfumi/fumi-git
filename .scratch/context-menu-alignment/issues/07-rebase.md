# 07 — 变基（`git rebase` + rebase 操作态 + 继续 / 跳过 / 中止）

**What to build:** 后端新增 `rebase(ref)`（`git rebase <ref>`），并把 rebase 作为**第四种「进行中的操作」**接入既有设施：`Operation` 枚举加 `Rebase`（serde `"rebase"`、`as_str()` 加 `"rebase"`）；`read_operation` 增识别（`git rev-parse --git-path rebase-merge` / `rebase-apply` 目录存在即视为 rebase 进行中，**优先级最高**——变基中途 HEAD 处于分离态，其它探测可能误判）；`abort_operation` 支持 rebase → `git rebase --abort`；`continue_operation(op, action)` 增 `action: "continue" | "skip"`，rebase 的 skip → `git rebase --skip`，其它 op 只接受 `"continue"`。`git rebase --continue` 可能拉起编辑器，该次调用须注入 `GIT_EDITOR=true`（`GitRepo::run` 若无 env 能力，加一个最小 env 变体，**不改既有调用点**）。前端：`GitOperation` 并集加 `"rebase"`，横幅文案表加 `rebase: { progress: "变基进行中", cont: "继续变基" }`；本地分支菜单与远程分支菜单同时追加「将当前分支变基到此分支…」（右键当前分支时禁用；脏工作树时走既有三选拦截框，选项文案为「stash 后变基」）；确认框说明「把 \<当前分支\> 变基到 \<目标\>」，并提示本地提交会被重写；冲突视图在 `operation === "rebase"` 时额外渲染「跳过本次提交」按钮。变基成功后刷新图谱与分支状态；若该分支已推送过，toast 追加说明需要 force push（本批不提供入口）。

**Blocked by:** 01（ui-spec 规则先行）, 02（菜单构建层）

**Status:** ready-for-agent

- [x] Rust 夹具测试先写后接 UI，覆盖五条路径：无冲突变基成功（提交被重排/重写）、冲突停下（断言 `operation == "rebase"` 且未合入清单非空）、`--continue` 完成、`--abort` 完整回滚到变基前状态、`--skip` 丢弃本次提交继续
- [x] `git rebase --continue` 在测试与实现中都不阻塞（无编辑器交互）
- [x] 本地分支菜单与远程分支菜单都出现「将当前分支变基到此分支…」；右键当前分支时禁用
- [x] 脏工作树时先弹拦截框（「stash 后变基」语义 = stash push → rebase，不自动 pop）；选「取消」无任何变化
- [x] 变基冲突时横幅显示「变基进行中」、冲突清单与解决视图可用，且多出「跳过本次提交」出口
- [x] 变基成功后图谱、侧栏当前分支标识、ahead/behind 徽章全部刷新
- [x] 已推送分支变基成功的 toast 里含「需要 force push（本应用暂不提供）」的说明
- [x] 无冲突变基不会误报操作进行中（`read_operation` 不误判）
- [x] `cargo test` 与 `pnpm test` 通过

## Comments

- 2026-10-11 完成（前端提交 995e553）。后端 `rebase(ref)` + `Operation::Rebase`（`read_operation` **优先**探测 `rebase-merge` / `rebase-apply`，`--git-path` 的相对结果先拼回仓库根；`--continue` / `--skip` / `--abort` 均注入 `-c core.editor=true` 以免拉起编辑器）；前端横幅「变基进行中」+「继续变基 / 跳过本次提交 / 中止」，本地与远程分支菜单都出现「将当前分支变基到此分支…」（右键当前分支时禁用），脏树走三选拦截（「继续变基 / stash 后变基」），成功且该分支已有上游时追加 force push 说明。
- 落位说明：工单原文把「跳过本次提交」写在冲突视图，实际落在中栏操作横幅——「继续 / 中止」本来就在那里，冲突视图本身没有动作行；语义与清单一致（`operation === "rebase"` 时才出现）。
- 验证：Rust `rebase_clean_replays_commits_onto_target`、`rebase_conflict_continue_abort_and_skip`（五条路径 + 非法动作）；store 侧确认后变基 + force push 说明、冲突停下提示、分离 HEAD 与写忙拒绝、脏树拦截（stash 后变基 = stash push → rebase）、`skipOperationFlow` 仅 rebase 可用；`cargo test -- --test-threads=1` 52 passed / 1 ignored，`pnpm test` 134 passed。
