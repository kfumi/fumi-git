# 03 — 远程分支右键菜单（检出 / 新建分支 / 合并 / 复制 / 推送 / 抓取 / 删除远程分支）

**What to build:** 侧栏远程分支目前**完全没有右键菜单**（点击只定位 tip），本票把它建起来：检出（创建同名本地跟踪分支并迁出；本地已有同名分支时禁用并给 hint 指向本地分支菜单）、从此处新建分支…（远程分支 tip 为起点）、合并到当前分支…、复制分支名（复制 `<remote>/<branch>` 全名）、推送（把同名本地分支推到该远程；无同名本地分支时禁用）、抓取（只抓该远程）、删除远程分支…（danger + 二次确认，文案说明不可从本地恢复）——「将当前分支变基到此分支…」由 07 追加，本票不放占位项。后端新增两项：`fetch_remote(remote?)`（无参 = 既有 `git fetch --all`，有参 = `git fetch <remote>`，**不加 `--prune`**）、`delete_remote_branch(remote, branch)`（`git push <remote> --delete refs/heads/<branch>`，错误映射复用 `map_push_err`）。远程名与分支名的切分沿用既有分组规则（`name` 首段即远程名）。

**Blocked by:** 02（菜单构建层）

**Status:** ready-for-agent

- [x] 右键远程分支出现菜单，项集合与顺序符合 spec；组件仍不含菜单文案字面量
- [x] 「检出」创建同名本地跟踪分支并迁出，`for-each-ref %(upstream:short)` 显示跟踪关系；本地已有同名分支时该项禁用
- [x] 「删除远程分支…」二次确认后远程 ref 从侧栏消失；删除不存在的分支/无权限时给出可读错误而非裸报错
- [x] 「推送」把同名本地分支推到该远程成功；无同名本地分支时禁用
- [x] 「抓取」只抓该远程（不触发其它远程）；无参 `fetch_remote` 行为与既有 `--all` 完全一致（回归不变）
- [x] Rust 夹具测试（复用 `repo_with_origin` / `repo_with_two_remotes`）覆盖带参 fetch、delete_remote_branch 成功与失败形态
- [x] store 测试（mock IPC）覆盖检出 / 推送 / 抓取 / 删除四个新流程的成功与失败路径
- [x] `cargo test`（src-tauri 下）与 `pnpm test` 通过

## Comments

- 2026-10-11 完成（前端提交 995e553；后端与测试见本批后续提交）。菜单由 `src/lib/menus.ts` 的 `remoteMenu` 单点构造，Sidebar 只铺动作包，组件内不含菜单文案字面量。后端 `fetch(remote?)`（无参 = `fetch --all`，不加 `--prune`）与 `delete_remote_branch`（先 `ls-remote --heads` 探存在再 `push --delete`；实测本地/file:// 传输删除不存在的 ref 会静默 exit 0，故必须前置探测）。
- 验证：`cargo test -- --test-threads=1` 52 passed / 1 ignored —— 新增 `checkout_remote_branch_sets_upstream`（检出远程分支后 `%(upstream:short)` == `origin/topic`，且 `list_refs.upstream` 一致）与 `delete_remote_branch_success_and_missing`；`pnpm test` 134 passed（检出/推送/抓取/删除四流程各有成功与失败用例）；`pnpm build` 通过。
