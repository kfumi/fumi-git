# 04 — 上游管理（设置 / 取消上游关联）+ 本地分支菜单的推送与抓取

**What to build:** 让本地分支的远程关联可控，并把同步入口搬进分支菜单：后端 `list_refs` 的 `REF_FORMAT` 增加 `%(upstream:short)`，`RefEntry` 增 `upstream: string | null`（远程 ref 与标签恒为 `null`）；新增 `set_upstream(branch, upstream)`（`git branch --set-upstream-to=<upstream> <branch>`）与 `unset_upstream(branch)`（`git branch --unset-upstream <branch>`）。前端本地分支菜单追加四项：「设置上游分支…」（对话框列出远程分支，已有 upstream 时**禁用**并给 hint——要更换先「取消上游关联」）、「取消上游关联」（无 upstream 时禁用）、「推送」（有上游 → 把该分支推到上游远程同名分支，**目标分支是右键的那个分支**；无上游 → 复用既有「建立上游关联并推送」对话框，作用对象同样是右键分支而非当前分支）、「抓取」（有上游 → 只抓该上游远程；无上游 → 全量抓取）。这四项按 spec 的组顺序落位：前两项在「重命名…」之后的管理组，「推送 / 抓取」在末组。

**Blocked by:** 02（菜单构建层）, 03（带参 fetch）

**Status:** ready-for-agent

- [ ] `RefEntry.upstream` 与 `git for-each-ref %(upstream:short)` 一致（夹具断言）；远程 ref 与标签为 `null`
- [ ] `set_upstream` 后 `for-each-ref` 与 `branch -vv` 显示新关联；非法/不存在的 upstream 由 git 拦截并规整为可读错误
- [ ] `unset_upstream` 后关联消失，`ahead/behind` 徽章随之归零
- [ ] 已有上游时「设置上游分支…」禁用且 hint 说明先取消；无上游时「取消上游关联」禁用
- [ ] 非当前分支的「推送」成功，且**不改动当前分支的上游关联**
- [ ] 无上游分支的「推送」弹出既有建立关联对话框，完成后该分支上游被建立（`push -u` 语义）
- [ ] 本地分支「抓取」只抓该分支的上游远程；无上游时走全量抓取
- [ ] Rust 夹具测试覆盖 set/unset upstream 与 `list_refs` 的新字段；store 测试覆盖四个菜单流程的成功与失败
- [ ] `cargo test` 与 `pnpm test` 通过
