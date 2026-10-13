# 03 — 远程分支右键菜单（检出 / 新建分支 / 合并 / 复制 / 推送 / 抓取 / 删除远程分支）

**What to build:** 侧栏远程分支目前**完全没有右键菜单**（点击只定位 tip），本票把它建起来：检出（创建同名本地跟踪分支并迁出；本地已有同名分支时禁用并给 hint 指向本地分支菜单）、从此处新建分支…（远程分支 tip 为起点）、合并到当前分支…、复制分支名（复制 `<remote>/<branch>` 全名）、推送（把同名本地分支推到该远程；无同名本地分支时禁用）、抓取（只抓该远程）、删除远程分支…（danger + 二次确认，文案说明不可从本地恢复）——「将当前分支变基到此分支…」由 07 追加，本票不放占位项。后端新增两项：`fetch_remote(remote?)`（无参 = 既有 `git fetch --all`，有参 = `git fetch <remote>`，**不加 `--prune`**）、`delete_remote_branch(remote, branch)`（`git push <remote> --delete refs/heads/<branch>`，错误映射复用 `map_push_err`）。远程名与分支名的切分沿用既有分组规则（`name` 首段即远程名）。

**Blocked by:** 02（菜单构建层）

**Status:** ready-for-agent

- [ ] 右键远程分支出现菜单，项集合与顺序符合 spec；组件仍不含菜单文案字面量
- [ ] 「检出」创建同名本地跟踪分支并迁出，`for-each-ref %(upstream:short)` 显示跟踪关系；本地已有同名分支时该项禁用
- [ ] 「删除远程分支…」二次确认后远程 ref 从侧栏消失；删除不存在的分支/无权限时给出可读错误而非裸报错
- [ ] 「推送」把同名本地分支推到该远程成功；无同名本地分支时禁用
- [ ] 「抓取」只抓该远程（不触发其它远程）；无参 `fetch_remote` 行为与既有 `--all` 完全一致（回归不变）
- [ ] Rust 夹具测试（复用 `repo_with_origin` / `repo_with_two_remotes`）覆盖带参 fetch、delete_remote_branch 成功与失败形态
- [ ] store 测试（mock IPC）覆盖检出 / 推送 / 抓取 / 删除四个新流程的成功与失败路径
- [ ] `cargo test`（src-tauri 下）与 `pnpm test` 通过
