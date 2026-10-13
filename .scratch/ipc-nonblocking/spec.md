Status: ready-for-agent

# Spec：git 调用的非阻塞执行与刷新成本（P0–P2）

> 来源：2026-10-13 与用户的会话。用户报告「执行 git 操作时系统经常无响应、卡死」，要求排查并讨论。
> 排查结论：57 个 Tauri 命令全部是同步命令，git 子进程在主线程上阻塞等待；一轮 `refresh()`
> 顺序起 14 个 `git.exe`，本机实测合计 4.2–4.6 秒，写操作翻倍。
> 用户指定范围 P0–P4，本 spec 覆盖 P0–P2（子项目 A）；P3 / P4 另开
> `.scratch/remote-task-control/` 与 `.scratch/render-perf/`（见「Out of Scope」）。
> 验收口径为用户选定的**相对口径**（见「Test Decisions」）。
> 其余细节由 agent 按推荐方案代持，在 Implementation Decisions 中标注，可随时推翻。

## Problem Statement

用户在 **任何** git 操作期间都会遇到整个软件无响应：点「抓取」、检出分支、暂存、提交之后，
界面出现一条 busy 提示就僵住，Windows 标题栏随后标注「无响应」。

根因是一条完整的阻塞链，逐环有据：

1. `src-tauri/src/commands.rs` 的 **57 个命令全部是同步命令**（`lib.rs` 逐个注册，零个 `async`；
   其中 53 个 git-bound、4 个纯 config）。
2. 非 async 的 `#[tauri::command]` 由宏生成 `body_blocking`，**直接内联执行函数体**
   （`tauri-macros/src/command/wrapper.rs:398-432`），Tauri 官方文档明确：
   「同步函数……默认跑在主线程上，需要 `async` 才不阻塞主线程」。
3. IPC 派发不换线程：`create_ipc_handler` 内联调用 handler
   （`tauri-runtime-wry/src/lib.rs:5273-5293`），即跑在 WebView2 消息线程 = tao 事件循环主线程。
4. `spawn_git` 用 `child.wait_with_output()` **阻塞等待**，无超时、无取消、输出不流式
   （`src-tauri/src/git.rs:61-93`）。

两处放大器让问题从「慢」变成「卡死」：

- **并发被串行化**：`refresh()` 用 `Promise.all` 并发发 6 个 IPC（`src/stores/repo.ts:1106-1113`），
  看起来并行，实际在主线程上逐个执行 → 墙钟 = 各段之**和**，不是最大值。
- **进程数远超预期**：一轮 `refresh()` 触发 **14 个** `git.exe`，其中真正干活的只有 3 个
  （log / status / for-each-ref）。`read_operation` 为了判断「是否在 merge / rebase 中」
  自己 spawn 了 5 次 `rev-parse`（`git.rs` 的 `read_operation`）。
- **写操作翻倍**：`runWrite` 成功后自己 `refresh()`，`.git` 的 watcher 500ms 后再发
  `repo-changed` → `App.tsx:57` 再 `refresh()`，即**每次写操作 2 轮 = 28 个进程**。
- **工作区变更也全量刷新**：在编辑器里存一次盘就会触发一轮完整刷新（含最贵的 `get_log`）。

**实测（本机，取多次运行的 min 值，方法见附录）**：一轮 `refresh()` 的 14 项顺序合计
**小仓库（62 提交）4227 ms、10 万提交仓库 4588 ms**。小仓库几乎全是进程启动开销——
本机单次进程创建成本异常高（`cmd /c exit` 193 ms、`git --version` 284 ms，20 次均值；
正常机器应 5–20 ms），环境里跑着 360 安全卫士与 TortoiseGit 的 TGitCache。

还有一个**记录在案但不在本 spec 范围**的事实：`scripts/gen-perf-repo.sh` 生成不出夹具
（`data 16` 与实际 15 字节不符，fast-import 流错位 → `fatal: Unsupported command: lob`），
即「性能验收夹具」这条流程此前从未跑通。本 spec 的第 0 张工单修它。

## Solution

**P0 执行模型**：所有 git-bound 命令改为 `async fn` + `tauri::async_runtime::spawn_blocking`，
配 `offload` / `offload_write` 两个助手；同时引入**仓库写锁**，把并发写从「git lock 报错」
变成「排队」。

**P1 调用折叠**：`status --porcelain=v2 --branch -z` 一次拿全状态 + 分支 + 上游 + 领先/落后；
`GitRepo` 缓存 gitdir 让 `read_operation` 归零；`show` / `diff` 的输出格式合一。
一轮 `refresh()` 从 **14 个进程降到 6 个**（log / status-v2 / summary / stash / refs / remotes；
分离 HEAD 时 7）。
**P2 刷新编排**：`repo-changed` 事件携带变更分类，前端按分类决定刷什么、单飞合并、
写操作后抑制自己触发的那一轮。写操作刷新轮数 **2 → 1**，纯工作区变更不再重拉 log。

三者叠加后的目标形态：任何 git 操作期间窗口保持可交互；一轮刷新墙钟与手动跑同样 6 条
git 命令同量级。

**交付批次**（分批的理由：让 P0 的收益最早可验收；机制若有问题可独立回滚；风险分批暴露。
初稿曾把「避开与并发 graph-filter 会话在 `git.rs` 上撞车」列为理由之一，该会话的改动已于
`96ddd5c` / `31ea5df` 合入本分支，此条不再适用）：

| 批次 | 内容 | 工单 |
|---|---|---|
| 前置 | 修性能夹具脚本 | `00-fix-perf-fixture-script` |
| 批 1（P0） | 执行模型 + 写锁 | `01-execution-model-and-write-lock` |
| 批 2（P1） | 调用折叠 | `02-call-folding` |
| 批 3（P2） | 刷新编排 | `03-refresh-orchestration` |

## User Stories

1. 作为开发者，我想在任何 git 操作进行期间仍能拖动窗口、切换 tab、滚动列表，
   以便不误判软件已经崩溃。
2. 作为开发者，我想让一轮刷新更快（更少进程、真并发），以便频繁的日常操作不累积成等待。
3. 作为开发者，我想让编辑器里存一次盘只刷新工作区状态、不重拉提交历史，
   以便不被无谓的整轮刷新打断。
4. 作为开发者，我想让每个写操作只触发一轮自动刷新，以便不做重复等待。
5. 作为开发者，我想在写操作并发时得到「排队」而不是 `Unable to create '.../index.lock'`，
   以便不面对看不懂的错误、也不担心仓库被写坏。
6. 作为开发者，我想让验收标准是「与手动跑同样命令同量级」而不是拍死的毫秒数，
   以便我这台被安全软件拖慢的机器的环境问题不被记到代码账上。
7. 作为开发者，我想确认现有前端契约（`RepoStatus` 分组、`FileEntry.status` 单字符、
   `GitError` 形状）在后端改写后逐位不变，以便 1780 行前端单测与渲染层不被牵连。

## Implementation Decisions

**执行模型**

- 手法是 `async fn` + `tauri::async_runtime::spawn_blocking`，**不是** `#[tauri::command(async)]`
  属性。宏的 `body_async` 把同步函数体包进 async task（`wrapper.rs:363-386`），
  于是阻塞发生在 tokio worker 上（默认 worker 数 = CPU 核数，本机 8）——14 个并发 git 会占满
  worker 并把其它 async 任务一起饿死；`spawn_blocking` 走独立的阻塞池（上限 512），
  才是「真并行且不占用 async 调度器」。
- 新增三个助手：`active_repo(&AppState) -> Result<GitRepo, GitError>`（抽出现有 `with_active`
  的取锁 + 克隆，纯同步、不跨 await）、`offload`、`offload_write`。57 个命令里 53 个 git-bound 的
  各改 1 行为 `offload(state, move |repo| git::xxx(repo, &arg)).await`。
- **4 个纯 config 命令保持同步**：`get_app_config` / `set_theme` / `remove_recent` /
  `open_file_in_editor`（不碰 git，改动无收益）。
- `open_repo` 特殊：先 `offload` 完成 `GitRepo::open` + `repo_meta`，再回到 async 上下文更新
  `active` / watcher / config（`Mutex` 不跨 await 持锁；现有临界区本来就短）。
- `spawn_blocking` 的 `JoinError`（线程 panic）映射为 `GitError::Io`。
- **契约不变**：命令名 / 参数 / 返回值全部不动；`GitError` 的 `kind/message` tagged enum 不动
  （前端 `asGitError` 与全部调用点零改动）。

**仓库写锁（异步化的直接副作用，必须同时落地）**

- 以前主线程冻结顺带充当了**隐式写互斥**——界面卡住时用户点不动第二次。异步化后 UI 流畅，
  用户可以在 `switch_branch` 中途点 `commit`。git 自身的 `index.lock` / ref lock 能防数据损坏，
  但会抛出 `Unable to create '.../index.lock': File exists` 这类难懂错误。
- 实现：`AppState` 增 `repo_write_lock: Arc<Mutex<()>>`；`offload_write` 在 **blocking 闭包内部**
  抢锁（闭包是同步代码，`std::sync::Mutex` 可正常使用，不跨 await），保证同仓库写操作串行。
- 覆盖范围：**38 个**会写 `.git` 或工作区的命令（stage / unstage / commit / fetch / pull / push* /
  merge / abort / continue / revert / cherry-pick* / switch / stash_push|apply|drop / discard* /
  create_branch / reset_branch / delete_branch / rename_branch / delete_remote_branch /
  set_upstream / unset_upstream / create_tag / checkout_commit / amend_message / rebase /
  write_worktree_file / resolve_take）。
- **读 14 个不加锁**（`get_*` / `list_*` / `conflict_versions` / `read_worktree_file` /
  `stash_list` / `stash_diff` / `branch_unmerged_count`），保持真并发；`open_repo` 特殊处理。
- 前端 `writeBusy` 保留（即时反馈 + 拒绝重复触发），两者职责不同：前者是后端正确性，后者是交互反馈。

**调用折叠（每条都已用真实 git 实测，见附录 B）**

- `get_status`：`status --porcelain -z` → **`status --porcelain=v2 --branch -z`**，一次拿全
  文件状态 + `# branch.head` + `# branch.upstream` + `# branch.ab +N -M`。
  于是 `get_branch_summary` 的 `symbolic-ref` / `rev-parse @{u}` / `rev-list --left-right --count`
  全部消失。
  - v2 记录形态（实测六种）：`1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`；
    `2 <XY> … <X><score> <path>` + NUL + 原路径（重命名）；`? <path>`（未跟踪）；
    `! <path>`（忽略）；`u …`（冲突）；`# branch.*`（头部）。
  - `# branch.upstream` / `# branch.ab` **只在有效上游时出现**（实测：`rev-parse @{u}` 能解析时才有）
    → 与现状「`@{u}` 失败即 `upstream: None`」语义一致，无行为变化。
- `read_operation` 归零进程：打开仓库时解析一次 gitdir 并缓存进 `GitRepo { root, gitdir }`，
  之后直接判断 `<gitdir>/MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` / `rebase-merge` /
  `rebase-apply` 是否存在。必须兼容**子目录打开**与 **linked worktree**（此时 `.git` 是文件而非目录），
  故仍以 `rev-parse` 的一次解析结果为准，不硬拼 `root/.git`。
- `get_commit_detail`：5 次 → **2 次**（`show -s --format=<元信息+body>` 一次；
  `show --format= --raw --numstat --patch -M` 一次）。
- `get_compare`：**5 次 → 4 次**（现状：`resolve_compare_ref` 对字面量 `HEAD` 的 `rev-parse` 1 次
  + `diff --numstat` 1 次 + `diff` 1 次 + `commit_meta` 2 次；目标：前两项保留，两次 `diff` 合一）。
- ⚠️ **弃用 `--name-status`**：实测它与 `--numstat` / `--patch` **不能合用**
  （`--name-status` 会把后两者的输出整个吞掉，与参数顺序无关），
  而 **`--raw --numstat --patch` 三者可以合用且都输出**。status 字母改由 `--raw` 提供
  （`:oldmode newmode oldsha newsha <Status>\t<path>`，重命名为 `R100\told\tnew`），
  顺带可删 `parse_name_status` 与 `get_commit_detail` 里 statuses 的覆盖逻辑。
- 解析改动是**真实风险点**：v2 与 `--raw` 的解析器必须逐形态有夹具用例（见 Test Decisions），
  并保证 `RepoStatus { staged / unstaged / unmerged }` 的分组与 `FileEntry.status`
  单字符（A/D/M/R/U）**逐位不变**——前端 1780 行单测打桩的就是这个形状。
- `list_refs` 已是 1 次，不动；`list_remotes` 保留（无 ref 的 remote 无法从 refs 推导）。

**刷新编排**

- 后端 `repo-changed` 的 payload 从 `()` 改为携带分类（`index` / `refs` / `head` / `worktree`）：
  `watcher.rs` 已有 500ms 防抖，在窗口内累积变更路径的并集再发一次事件，按路径前缀分类
  （`.git/index`、`.git/refs/**`、`.git/HEAD`、`.git/logs/**`、其余为工作区）。
- 前端 `refresh()` 改为**单飞 + 合并**：已有刷新在飞时只置 dirty 标记，落地后再补跑一轮，
  而不是并发起多轮。
- 前端按分类分流：只有 refs / head 变才重拉 log；只有 index / worktree 变只重拉 status（+ stash）。
- 写操作后 **1200ms** 内抑制自己触发的 `repo-changed`（窗口必须 ≥ watcher 的 500ms 防抖 + 余量，
  否则抑制不住那一轮，等于白做），消除「runWrite 的 refresh + watcher 的 refresh」双轮。
- `get_branch_summary` **保留**（不删命令、不改契约）：它被 20+ 处前端与 Rust 测试直接消费，
  为省 1 次 git 调用去动这个契约是收益/风险倒挂；工单 02 已把它从 3 次降到 1 次。

**前置**

- `scripts/gen-perf-repo.sh` 两处各一行：`data 16` 改为 `data 15`（`echo "content v$i pad"` 实际输出 15 字节），
  以及 `from :$main_tip` 改为 `from $main_tip`（`main_tip` 自带冒号，原样输出 `from ::341`；被前一处掩盖），
  否则验收夹具生成不出来。已用 hexdump 与 fast-import 报错（含 crash 报告里被 `*` 标出的 `* from ::341`）定位。

**显式否决项**

- 「换成 libgit2 / gitoxide 以避免 spawn 进程」——**与 `AGENTS.md`「git CLI 是唯一 Git 后端」
  相冲突，显式否决**。本 spec 的收益在 CLI 约束下已可达成。
- 新增 IPC 面重构（单个 `get_repo_snapshot` 命令 + 事件驱动的精准刷新）：对「不卡」没有额外收益
  （真并发已由 P0 拿到），却要破坏性改动前端 IPC 契约与 1780 行单测，性价比最低，不纳入。
- 深分页策略（`limit = max(200, len/4)` 且每轮重跑已加载窗口）与 `--skip` 语义：另开工单，
  本 spec 不碰。

## Out of Scope

- **P3 长任务可控**（fetch / pull / push / hook 的超时、取消、stderr 流式进度）→
  `.scratch/remote-task-control/`，`Blocked by` 本 spec 的批 1。
- **P4 渲染性能**（`DiffView` 虚拟化、图谱 `computeGraph` 增量）→ `.scratch/render-perf/`，
  与本 spec 零耦合，可并行。
- **P5 环境因素**（360 安全卫士、TortoiseGit TGitCache、杀软排除项）：仅在附录记录实测数据，
  不采取行动。
- 绝对毫秒验收线（用户已选相对口径）。
- 前端搜索框下推 git、筛选状态持久化等既有工单范围。

## Test Decisions

**静态验收命令**：`cargo test -- --test-threads=1`（在 `src-tauri/`）、`pnpm test`、`pnpm build`
（含 tsc 类型检查）。

**Rust（真实 git 夹具，不 mock git）**

- 现有 55 个用例**语义零改动**全绿（这是「契约未变」的主要证据）。
- `status --porcelain=v2 --branch -z` 解析：普通修改 / 新增 / 删除 / 重命名（含 NUL 后的原路径）/
  未跟踪 / 忽略 / 冲突，各一条；分组结果与 v1 解析逐位一致（同一工况下两条路径产出相等的 `RepoStatus`）。
- `# branch.upstream` / `# branch.ab`：有有效上游时解析出 upstream 与 ahead/behind；
  无上游时不出现且 `upstream == None`。
- `read_operation`：夹具手工造 `MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` /
  `rebase-merge/` / `rebase-apply/` 五种中间态，各自命中；都不存在时为 `None`。
- gitdir 缓存：正常仓库、子目录打开、linked worktree（`.git` 为文件）三种入口解析正确。
- `--raw --numstat --patch` 合并解析：状态字母 / 增删计数 / 二进制（`-\t-`）/ 重命名
  （`R100\told\tnew`）/ patch 段落切分各一条，且与改造前 `get_commit_detail` 的产出等价。
- 写锁：两个并发写命令串行执行（断言执行区间不重叠）；读命令不受写锁阻塞。

**前端（打桩 IPC）**

- `refresh()` 单飞 + 合并：在飞期间连续触发 N 次只产生「1 轮 + 1 轮补跑」。
- 分类分流：只带 `index`/`worktree` 的事件不触发 `get_log`；带 `refs`/`head` 的触发全量。
- 写操作后 500ms 抑制窗口内到达的 `repo-changed` 被忽略。
- 既有消费点（`currentBranch()` / `pushUpstreamFlow` 等）行为不变；`get_branch_summary` **保留**
  （Implementation Decisions 已撤回「删命令 + summary 派生」的方案，本行原文是它的残留）。

**端到端（人工走查，结果回填到工单 Comments；相对口径，不设绝对毫秒线）**

1. 打开 10 万提交夹具（先修脚本）并触发刷新 → 窗口可拖动、可切 tab、可滚动，
   **不出现 Windows「无响应」**。
2. 刷新期间 `Get-Process git` 能观测到 **≥3 个 `git.exe` 并发存在**（证明主线程串行化已解除）。
3. 一轮刷新的墙钟时间与在终端手动跑同样 6 条 git 命令**同量级**（判据：不出现「多出数倍」的差距，
   即刷新墙钟 ≤ 手动墙钟 + 一次进程启动开销，本机约 0.3 s）。
4. 写操作触发的自动刷新 **≤ 1 轮**。
5. 写操作并发（切分支中途点提交）→ **排队**，不出现 git lock 报错。

## 附录 A：实测数据（2026-10-13，本机 PowerShell 7 / git 2.35.1.windows.2）

方法：`ProcessStartInfo` 直接 CreateProcess + 等待，排除 PowerShell 管道开销；每项取多次
运行的最小值（min 最接近固有成本）。夹具为按 `gen-perf-repo.sh` 意图重建的
100,001 提交仓库（线性主干 + 200 提交 feat 分支 + 一次合并 + 标签 + 远程跟踪 ref）。

一轮 `refresh()` 的 14 个进程（min）：

| 触发命令 | git 子进程 | 小仓库(62) | 100k 提交 |
|---|---|---|---|
| `get_log` | `log --topo-order --all -n200` | 274 ms | 1105 ms |
| `get_status` | `status --porcelain -z` | 308 | 255 |
| ↑ `read_operation` | `rev-parse --git-path rebase-merge` | 243 | 222 |
| ↑ `read_operation` | `rev-parse --git-path rebase-apply` | 602 | 221 |
| ↑ `read_operation` | `rev-parse --verify MERGE_HEAD` | 289 | 248 |
| ↑ `read_operation` | `rev-parse --verify CHERRY_PICK_HEAD` | 328 | 385 |
| ↑ `read_operation` | `rev-parse --verify REVERT_HEAD` | 436 | 249 |
| ↑ `current_branch` | `symbolic-ref --short HEAD` | 310 | 244 |
| `get_branch_summary` | `symbolic-ref --short HEAD` | 255 | 304 |
| ↑ | `rev-parse --abbrev-ref @{u}` | 241 | 295 |
| ↑ | `rev-list --left-right --count` | 221 | 280 |
| `stash_list` | `stash list` | 223 | 276 |
| `list_remotes` | `remote` | 246 | 266 |
| `list_refs` | `for-each-ref` | 251 | 240 |
| | **合计** | **4227 ms** | **4588 ms** |

进程启动成本与排序代价（100k 提交，min / 中位）：

| 项 | 值 |
|---|---|
| `cmd /c exit` × 20（系统进程对照） | 193 ms / 次 |
| `git --version` × 20 | 284 ms / 次 |
| `git rev-parse`（仓库内）× 20 | 259 ms / 次 |
| `log --topo-order -n200 --all` | 697 / 819 ms |
| `log --date-order -n200 --all` | 672 / 767 ms |
| `log -n200 --all`（默认排序） | 161 / 179 ms |
| `get_commit_detail` 的 5 个子调用 | 169–231 ms（纯进程开销） |

## 附录 B：git 行为实测（决定实现手法的依据）

| 事实 | 实测证据 |
|---|---|
| `--name-status` 与 `--numstat` 不能合用 | `show --numstat --name-status` 与反序都只输出 `M\ta.txt` |
| `--name-status` 与 `--patch` 不能合用 | `show --name-status --patch` 只有 name-status |
| `--raw --numstat --patch` 可合用 | 依次输出 `:100644 100644 9eba93014 fbf77437a M\ta.txt`、`1\t1\ta.txt`、完整 diff |
| `--raw` 的重命名形态 | `:100644 100644 c1b0730 c1b0730 R100\tren.txt\trenamed.txt` |
| `numstat` 的重命名形态 | `0\t0\tren.txt => renamed.txt`（与 `--raw` 不同；`parse_numstat` 已正确处理两种） |
| `status v2 --branch` 有有效上游时 | `# branch.oid` / `# branch.head main` / `# branch.upstream origin/main` / `# branch.ab +1 -0` |
| 无有效上游时 | 只有 `# branch.oid` / `# branch.head`（`rev-parse @{u}` 同样失败 → 与现状语义一致） |
| v2 重命名记录 | `2 R. N... … R100 renamed.txt` + **NUL** + `ren.txt` |
| v2 未跟踪记录 | `? m.txt` |
