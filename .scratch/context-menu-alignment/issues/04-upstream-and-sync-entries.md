# 04 — 上游管理（设置 / 取消上游关联）+ 本地分支菜单的推送与抓取

**What to build:** 让本地分支的远程关联可控，并把同步入口搬进分支菜单：后端 `list_refs` 的 `REF_FORMAT` 增加 `%(upstream:short)`，`RefEntry` 增 `upstream: string | null`（远程 ref 与标签恒为 `null`）；新增 `set_upstream(branch, upstream)`（`git branch --set-upstream-to=<upstream> <branch>`）与 `unset_upstream(branch)`（`git branch --unset-upstream <branch>`）。前端本地分支菜单追加四项：「设置上游分支…」（对话框列出远程分支，已有 upstream 时**禁用**并给 hint——要更换先「取消上游关联」）、「取消上游关联」（无 upstream 时禁用）、「推送」（有上游 → 把该分支推到上游远程同名分支，**目标分支是右键的那个分支**；无上游 → 复用既有「建立上游关联并推送」对话框，作用对象同样是右键分支而非当前分支）、「抓取」（有上游 → 只抓该上游远程；无上游 → 全量抓取）。这四项按 spec 的组顺序落位：前两项在「重命名…」之后的管理组，「推送 / 抓取」在末组。

**Blocked by:** 02（菜单构建层）, 03（带参 fetch）

**Status:** ready-for-agent

- [x] `RefEntry.upstream` 与 `git for-each-ref %(upstream:short)` 一致（夹具断言）；远程 ref 与标签为 `null`
- [x] `set_upstream` 后 `for-each-ref` 与 `branch -vv` 显示新关联；非法/不存在的 upstream 由 git 拦截并规整为可读错误
- [x] `unset_upstream` 后关联消失，`ahead/behind` 徽章随之归零
- [x] 已有上游时「设置上游分支…」禁用且 hint 说明先取消；无上游时「取消上游关联」禁用
- [x] 非当前分支的「推送」成功，且**不改动当前分支的上游关联**
- [x] 无上游分支的「推送」弹出既有建立关联对话框，完成后该分支上游被建立（`push -u` 语义）
- [x] 本地分支「抓取」只抓该分支的上游远程；无上游时走全量抓取
- [x] Rust 夹具测试覆盖 set/unset upstream 与 `list_refs` 的新字段；store 测试覆盖四个菜单流程的成功与失败
- [x] `cargo test` 与 `pnpm test` 通过

## Comments

- 2026-10-11 完成（前端提交 995e553）。`REF_FORMAT` 增 `%(upstream:short)` → `RefEntry.upstream`（远程 ref 与标签恒 `null`）；`set_upstream` / `unset_upstream` 落地；本地分支菜单接入「设置上游分支… / 取消上游关联 / 推送 / 抓取」，推送目标恒为被右键的分支（无上游时走既有「建立上游关联并推送」对话框，作用对象同样是该分支而非当前分支）。
- 验证：Rust `upstream_set_unset_and_list_refs_field`（含空参数拒绝）；store 侧 setUpstreamFlow（非法远程分支即时拦截 + 成功）、unsetUpstream、pushBranchFlow（有上游 → 上游远程同名分支；无上游 → push -u 对话框）、fetchForBranch（有上游只抓该远程 / 无上游全量）；`cargo test -- --test-threads=1` 52 passed / 1 ignored，`pnpm test` 134 passed。
- 评审整改（单轮只读评审 e1cc525..075c3ee）：`upstream_set_unset_and_list_refs_field` 增补真实 git 断言——领先 1 个提交时 `ahead == 1`，`unset_upstream main` 后 `upstream == None` 且 `ahead/behind` 归零（此前「徽章归零」只有 mock 证据）。
