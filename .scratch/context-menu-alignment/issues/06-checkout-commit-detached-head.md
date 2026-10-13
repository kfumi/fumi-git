# 06 — 检出该修订（分离 HEAD）+ 分离状态表达与写操作禁用矩阵

**What to build:** 本票推翻（并取代）一阶段决策 #12「不做 detached HEAD 迁出」。后端新增 `checkout_commit(hash)`（`git switch --detach <hash>`）。提交菜单新增「检出该修订…」（hint 标 detached；该提交已是 HEAD 时禁用）；检出前若工作区脏，走既有三选拦截框（带着改动检出 / stash 后检出 / 取消），检出失败由 git 兜底并规整为可读错误。分离 HEAD 时：侧栏「分支」区顶部出现状态行 `HEAD（分离）→ <短号>`（`summary.branch === null` 且 HEAD 存在时出现，点击 = 定位该提交，`text-warn` 强调色）；首次检出成功后 toast 说明可用「从此处新建分支」把提交挂回分支。分离态下写操作矩阵：**可用** = 检出、提交、stash、查看、复制类；**禁用并附「先从此处新建分支」提示** = 推送、抓取、合并、重命名、删除分支、设置/取消上游。分离态提交成功后 toast 追加一句「提交未挂在任何分支上，建议『从此处新建分支』」。工具栏推送按钮在分离态禁用并给出同样提示。

**Blocked by:** 02（菜单构建层）

**Status:** ready-for-agent

- [x] 「检出该修订…」后 HEAD 分离到该提交，图谱选中行与右栏详情可用；该提交已是 HEAD 时菜单项禁用
- [x] 脏工作树时先弹三选拦截框；选「取消」仓库无任何变化
- [x] 分离态侧栏出现 `HEAD（分离）→ <短号>` 状态行，点击定位该提交；切回任意分支后状态行消失
- [x] 分离态提交成功且 toast 提示「提交未挂在任何分支上，建议『从此处新建分支』」
- [x] 分离态下推送/抓取/合并/重命名/删除/设置或取消上游全部禁用并给引导提示；工具栏推送按钮同样禁用
- [x] 「从此处新建分支」在分离态可用，建完即不再是分离态
- [x] Rust 夹具测试覆盖 checkout_commit（断言 log 的 detached 分支与 `branch_summary` 无 upstream）；store 测试覆盖检出成功、脏树拦截、分离态禁用判定
- [x] `cargo test` 与 `pnpm test` 通过

## Comments

- 2026-10-11 完成（前端提交 995e553）。后端 `checkout_commit`（`git switch --detach <hash>`）；侧栏分支区顶部 `HEAD（分离）→ <短号>` 状态行，判定与解析集中在 `src/lib/menus.ts` 的 `detachedHead()`（解析后端 `current_branch()` 的 `(HEAD detached at <短号>)`，该格式已由 Rust 断言钉住，格式漂移会直接让测试红）；写操作矩阵在 `menus.ts` 单点实现（禁用 + 「先从此处新建分支」提示），工具栏拉取/推送/抓取同步禁用并给同样提示；分离态提交成功追加「提交未挂在任何分支上，建议『从此处新建分支』」。
- 验证：Rust `checkout_commit_detaches_head_without_upstream`（含分离态字符串格式断言）；store 侧检出成功 + 分离提示、脏树拦截、分离态提交提示、变基在分离态被拒；menus 侧分离矩阵 3 个用例（本地分支 / 远程分支 / `detachedHead` 解析）；`cargo test -- --test-threads=1` 52 passed / 1 ignored，`pnpm test` 134 passed。
