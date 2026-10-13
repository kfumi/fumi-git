# 01 — 后端：`get_log` 可选筛选（分支 / 提交者 / 时间）+ `get_user_identity`

**What to build:** 让日志查询支持三个维度的 git 侧过滤，并提供「我」的身份。
`git.rs` 增 `LogFilter { branch: Option<String>, author: Option<String>, since: Option<String> }`（serde `Deserialize`，全字段 `#[serde(default)]`），
新增 `get_log_filtered(repo, skip, limit, filter)`：分支非空 → 先按 `refs/heads/<name>` 校验存在（拒绝空值、拒绝以 `-` 开头的值），
通过则把该 ref 放在参数末尾，否则保持 `--all`；作者非空 → `--fixed-strings` + `--author=<子串>`（git 的 `--author` 默认是正则）；
时间 → `--since=`，值只接受白名单 `day` / `week` / `month`，分别映射 `24 hours ago` / `7 days ago` / `1 month ago`，其它值报「非法时间范围」。
既有 `get_log(repo, skip, limit)` 保留为「无筛选」薄包装（默认视角 = `--all`），既有调用与用例不动。
另增 `get_user_identity(repo) -> UserIdentity { name: Option<String>, email: Option<String> }`：`git config --get --default= user.name/user.email`，空串/空白规整为 `None`。
`commands.rs` 的 `get_log` 增参 `filter: Option<git::LogFilter>`（缺省 = 默认筛选）并注册新命令 `get_user_identity`。
`src/lib/types.ts` 镜像 `LogFilter` / `UserIdentity`，`src/lib/ipc.ts` 的 `getLog(skip, limit, filter?)` 与 `getUserIdentity()` 同步。

**Blocked by:** 无

**Status:** ready-for-agent

- [x] `get_log` 无筛选时行为与现状完全一致（`--all` + 拓扑序 + 分页）——既有 20 处用例一行未改即通过
- [x] 分支筛选只返回该分支可达提交（夹具：main 2 个提交、feat/other 各分叉 1 个 → `main` 得 2、`feat` 得 3、`other` 得 3、无筛选得 4）
- [x] 作者筛选按子串匹配姓名或邮箱；`--fixed-strings` 生效（作者 `a.b` 与 `axb` 并存时输入 `a.b` 只命中前者）
- [x] 时间筛选：10 天前的提交落在 `day` / `week` 之外、落在 `month` 之内；非法档位返回结构化错误
- [x] 不存在的分支、以 `-` 开头的分支名被拒绝（参数注入防护），错误文案可读
- [x] 分页在**过滤后**的集合上算：`main` 只有 2 个提交时 `skip=2, limit=1` 得空页且 `done=true`
- [x] `get_user_identity` 读本地 `user.name` / `user.email`；置空/置空白后返回 `None`（不落到全局配置）
- [x] `cargo test -- --test-threads=1` 全绿

**Comments**

- 2026-10-13 完成。`LogFilter` + `get_log_filtered`（作者走 `--fixed-strings`、时间走白名单、分支走 `refs/heads/<name>` 校验后替代 `--all`）+ 薄包装 `get_log`；`UserIdentity` / `get_user_identity` 落地并在 `lib.rs` 注册。
- 验证：新增 `log_filter_branch_author_and_since`（分支 / 作者固定串 / 三档时间 / 组合筛选 / 过滤后分页，另断言空白分支名按未筛选处理）、`log_filter_rejects_bad_args`（不存在的分支、`--all` 注入、非法时间范围）、`user_identity_from_config`（本地 config 取值 + 空值 → `None`）。
  `cargo test -- --test-threads=1`：**55 passed / 0 failed / 1 ignored**（原 52 + 新增 3），exit 0。
- 环境备注：并行的 `cargo test` 偶发 2 个**与本改动无关**的失败（`fetch_single_remote_and_all_regression` / `fetch_all_pulls_every_remote` 报 MSYS `sh.exe: fatal error - add_item ... errno 1`，即 Cygwin fork 失败），单线程跑稳定通过——沿用仓库既有的 `--test-threads=1` 验收姿势。

## 评审整改（2026-10-13）

- **参数注入断言恒真（已修）**：`--all` 这条原本只断言 `CommandFailed(_)`，而「`starts_with('-')` 拒绝」与「`refs/heads/--all` rev-parse 失败」都会落同族错误，删掉防护也照样绿。现断言错误文案包含「非法分支名」（两条路径文案可区分），防护被移除即红。
- **`get_log` 薄包装变死代码（已修）**：`commands.rs` 只调 `get_log_filtered` 后，三参数 `get_log` 只剩测试在用并触发 `dead_code` 警告。删除生产侧包装，测试模块内留一个同名三参数别名（注释说明只服务既有断言的「默认视角」），二十来条既有断言一行未改。
- **`--since` 语义（决定保留，记录）**：按 committer date 过滤且遇到更老提交提前停止遍历；`--since-as-filter` 语义更贴「过滤整个集合」但要求 git ≥ 2.37。保留 `--since`（与主流客户端一致 + 超大仓库省一趟全历史），代价记在 spec 的「评审整改」第 6 条。
- 验证：`cargo test -- --test-threads=1` → **55 passed / 0 failed / 1 ignored**，exit 0（含加固后的 `log_filter_rejects_bad_args`）。
