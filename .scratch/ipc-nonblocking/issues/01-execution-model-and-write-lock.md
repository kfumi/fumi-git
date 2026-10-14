# 01 — 执行模型：git 调用移出主线程 + 仓库写锁

**What to build:** 把全部 git-bound 命令从「主线程同步执行」改成「`async fn` + `spawn_blocking`」，
并引入仓库写锁。这是 P0：本票完成后 UI 在任何 git 操作期间不再冻结，
`refresh()` 的 6 个 IPC 也从「被主线程串行化」变成真并发。
**命令名 / 参数 / 返回值 / `GitError` 形状一律不变**，前端零改动。

## 为什么不是 `#[tauri::command(async)]`

宏的 `body_async`（`tauri-macros/src/command/wrapper.rs:363-386`）把同步函数体整个塞进一个 async task，
阻塞就发生在 tokio worker 上（默认 worker 数 = CPU 核数）；14 个并发 git 会占满 worker
并把其它 async 任务一起饿死。`spawn_blocking` 走独立阻塞池（上限 512），
才是「真并行 + 不占用 async 调度器」。

## 分类（57 个命令，已逐条核对）

- **读 → `offload`（14）**：`get_log` / `get_user_identity` / `get_commit_detail` / `get_status` /
  `get_worktree_diff` / `list_remotes` / `list_refs` / `conflict_versions` / `read_worktree_file` /
  `get_branch_summary` / `get_compare` / `stash_list` / `stash_diff` / `branch_unmerged_count`
- **写 → `offload_write`（38）**：`stage_paths` / `unstage_paths` / `commit_staged` / `fetch_remote` /
  `pull_remote` / `push_remote` / `push_upstream` / `push_to` / `push_all_remotes` / `merge_upstream` /
  `abort_operation` / `write_worktree_file` / `resolve_take` / `continue_operation` / `revert_commit` /
  `cherry_pick` / `cherry_pick_skip` / `cherry_pick_keep` / `switch_branch` / `stash_push` /
  `stash_apply` / `stash_drop` / `discard_worktree` / `delete_untracked` / `discard_staged` /
  `discard_staged_new` / `discard_all` / `create_branch` / `reset_branch` / `delete_branch` /
  `rename_branch` / `delete_remote_branch` / `set_upstream` / `unset_upstream` / `create_tag` /
  `checkout_commit` / `amend_message` / `rebase`
- **特殊（1）**：`open_repo`（要改 `State` + 重绑 watcher，见下）
- **保持同步（4）**：`get_app_config` / `set_theme` / `remove_recent` / `open_file_in_editor`（不碰 git）

## 代码

### 1) `AppState` 增写锁；`lib.rs` 的 `.setup()` 初始化

```rust
pub struct AppState {
    pub config_path: PathBuf,
    pub config: Mutex<AppConfig>,
    pub active: Mutex<Option<GitRepo>>,
    /// 切换仓库时 drop 旧 watcher 即停止监听
    pub repo_watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// 写操作串行化：异步化后主线程不再冻结，前端 writeBusy 挡不住已排队的调用
    pub write_lock: Arc<std::sync::Mutex<()>>,
}
```

`lib.rs`：

```rust
app.manage(commands::AppState {
    config_path,
    config: std::sync::Mutex::new(cfg),
    active: std::sync::Mutex::new(None),
    repo_watcher: std::sync::Mutex::new(None),
    write_lock: std::sync::Arc::new(std::sync::Mutex::new(())),
});
```

### 2) 助手函数（**删除**现有 `with_active`，换成这四个）

```rust
/// 取当前激活仓库。只在取引用时持锁：GitRepo 是廉价克隆（路径结构）
fn active_repo(state: &AppState) -> Result<GitRepo, GitError> {
    let guard = state
        .active
        .lock()
        .map_err(|_| GitError::Io("状态锁中毒".into()))?;
    guard
        .as_ref()
        .cloned()
        .ok_or_else(|| GitError::NotARepo("尚未打开任何仓库".into()))
}

/// 读路径：不持写锁 —— 读命令之间保持真并发
pub(crate) fn run_read<T>(repo: GitRepo, f: impl FnOnce(&GitRepo) -> GitResult<T>) -> GitResult<T> {
    f(&repo)
}

/// 写路径：在阻塞闭包内抢写锁，保证同一仓库的写操作串行（git lock 报错 → 排队）
pub(crate) fn run_write<T>(
    repo: GitRepo,
    lock: Arc<std::sync::Mutex<()>>,
    f: impl FnOnce(&GitRepo) -> GitResult<T>,
) -> GitResult<T> {
    // 守卫数据是 ()：panic 之后没有不变量被破坏，从中毒恢复，而不是让写操作永久失败
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    f(&repo)
}

/// 把 git 调用挪出主线程（P0 的核心）；JoinError（线程 panic）映射为 Io
async fn offload<T, F>(state: State<'_, AppState>, f: F) -> Result<T, GitError>
where
    T: Send + 'static,
    F: FnOnce(&GitRepo) -> GitResult<T> + Send + 'static,
{
    let repo = active_repo(&state)?;
    tauri::async_runtime::spawn_blocking(move || run_read(repo, f))
        .await
        .map_err(|e| GitError::Io(format!("git 任务执行失败：{e}")))?
}

async fn offload_write<T, F>(state: State<'_, AppState>, f: F) -> Result<T, GitError>
where
    T: Send + 'static,
    F: FnOnce(&GitRepo) -> GitResult<T> + Send + 'static,
{
    let (repo, lock) = (active_repo(&state)?, Arc::clone(&state.write_lock));
    tauri::async_runtime::spawn_blocking(move || run_write(repo, lock, f))
        .await
        .map_err(|e| GitError::Io(format!("git 任务执行失败：{e}")))?
}
```

顶部需 `use std::sync::Arc;`。

### 3) 命令改法（三种形态）

无参：

```rust
#[tauri::command]
pub async fn get_status(state: State<'_, AppState>) -> Result<RepoStatus, GitError> {
    offload(state, git::get_status).await
}
```

带参（参数 move 进闭包）：

```rust
#[tauri::command]
pub async fn stage_paths(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), GitError> {
    offload_write(state, move |repo| git::stage(repo, &paths)).await
}
```

先做纯计算再入池（`parse_operation` 只是字符串映射，不需要进阻塞池）：

```rust
#[tauri::command]
pub async fn abort_operation(state: State<'_, AppState>, op: String) -> Result<(), GitError> {
    let op = parse_operation(&op)?;
    offload_write(state, move |repo| git::abort_operation(repo, op)).await
}
```

`continue_operation` 同理（`action.as_deref()` 在闭包内取，`action` 已被 move 进去）。

### 4) `open_repo`（唯一要动 `State` 的命令）

```rust
#[tauri::command]
pub async fn open_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<RepoMeta, GitError> {
    // 1) 慢工作（open 自身会 spawn 1~2 个 git）挪出主线程
    let (repo, meta) = tauri::async_runtime::spawn_blocking(move || {
        let repo = GitRepo::open(std::path::Path::new(&path))?;
        let meta = git::repo_meta(&repo);
        Ok::<_, GitError>((repo, meta))
    })
    .await
    .map_err(|e| GitError::Io(format!("git 任务执行失败：{e}")))??;

    // 2) 回到 async 上下文改状态：都是短临界区，不跨 await 持锁
    if let Ok(mut active) = state.active.lock() {
        *active = Some(repo.clone());
    }
    if let Ok(mut slot) = state.repo_watcher.lock() {
        *slot = watcher::start(&app, &repo.root).ok();
    }
    if let Ok(mut cfg) = state.config.lock() {
        config::touch_recent(&mut cfg, &meta.path, &meta.name);
    }
    save_config(&state);
    Ok(meta)
}
```

## 测试：`commands.rs` 新增 `#[cfg(test)] mod tests`

为什么放这里：命令函数签名要求 `State`，需要 Tauri app 才能直接测；
把语义抽成 `run_read` / `run_write` 之后，不需要 app 就能锁住这两条不变量。

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    fn dummy_repo() -> GitRepo {
        GitRepo {
            root: std::path::PathBuf::from("."),
        }
    }

    #[test]
    fn write_lock_serializes_overlapping_writes() {
        let lock = Arc::new(Mutex::new(()));
        let start = Instant::now();
        let mut hs = Vec::new();
        for _ in 0..2 {
            let l = Arc::clone(&lock);
            hs.push(std::thread::spawn(move || {
                run_write(dummy_repo(), l, |_| {
                    std::thread::sleep(Duration::from_millis(150));
                    Ok(())
                })
                .unwrap();
            }));
        }
        for h in hs {
            h.join().unwrap();
        }
        // 串行 ⇒ 两段 150ms 不可能重叠；真并行跑完只需 ~150ms
        assert!(
            start.elapsed() >= Duration::from_millis(290),
            "写操作没有被串行化：{:?}",
            start.elapsed()
        );
    }

    #[test]
    fn read_is_not_blocked_by_write_lock() {
        let lock = Arc::new(Mutex::new(()));
        let guard = lock.lock().unwrap(); // 模拟写操作正持有锁
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(run_read(dummy_repo(), |_| Ok::<u32, GitError>(42)));
        });
        let got = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("读命令被写锁阻塞了");
        assert_eq!(got.unwrap(), 42);
        drop(guard);
    }
}
```

**类型注意**：本票落地时 `GitRepo` 只有 `root` 一个字段；工单 02 会加 `gitdir`，
届时 `dummy_repo()` 需要补字段（已写进 02 的清单）。

**Blocked by:** 无（端到端验收需要 00 先把夹具脚本修好）

**Status:** ready-for-agent

- [x] `cargo build` 通过；`cargo test -- --test-threads=1` 全绿（既有用例一行未改）—— `cargo build` 0 warning；`test result: ok. 57 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 234.62s`；附带 `pnpm test` = 7 files / 164 passed（与基线 `5c5b669` 一致）
- [x] 新增 2 个用例通过，且**反向验证有效**：临时删掉 `run_write` 里的抢锁 → `write_lock_serializes_overlapping_writes` 变红 —— RED/GREEN 原文见 Comments（RED = `写操作没有被串行化：151.0271ms`）
- [x] `#[tauri::command]` 数量仍为 57，其中 `async fn` = 53（4 个 config 命令保持同步），`with_active` 已消失 —— 实测 **57 / 53 / 0**
- [x] 命令名 / 参数名 / 返回类型与改造前逐一相同（前端零改动 + `pnpm build` 的 tsc 通过即为证）—— 57 个 `pub [async] fn` 的「名字 + 参数表 + 返回类型」与改造前逐条比对无差异；`pnpm build`（`tsc && vite build`）通过、1938 modules
- [x] 端到端：10 万提交夹具下触发刷新 → 窗口可拖动、可切 tab、可滚动，**不出现 Windows「无响应」**。（控制器联合端到端验收时勾选 —— ledger 裁决 R2）
      → 控制器联合端到端验收（ledger 裁决 R2）：`sample.log` 最终全量 **624,303/624,303 条样本 `fumi_responding=True`**、0 条例外（采样器已由控制器停止；其后 5,194 行 `gone` 是应用退出后的记录，退出点在全部验收场景结束之后）。刷新窗口 22:19:31.8–33.2 = 23 条全 True；19 次连发 `log` 的持续负载窗口 22:25:23–37 = 225 条全 True；切分支 / 提交全程亦全 True；负载期间的 tab 切换与滚动经 WebView2 CDP `Runtime.evaluate(userGesture:true)` 驱动并真实生效（激活类名迁移、`scrollTop` 真实位移）。**诚实披露：`Responding=True` 是客观代理，原生窗口拖动未实测**（走查时会话处于锁定状态，真实鼠标 / 键盘不可达）。
- [x] 端到端：刷新期间 `Get-Process git` 观测到 **≥3 个 git.exe 并发存在**。（控制器联合端到端验收时勾选 —— ledger 裁决 R2）
      → 控制器联合端到端验收（ledger 裁决 R2）：`trace-01-open.log` 一轮刷新 = **10 个应用自有 git 子进程**（`rev-parse` 22:19:31.839885 → `config user.email` 22:19:32.583492）；同期 `sample.log` 峰值 **11 个 git.exe = 应用自有 10**（已扣掉 1 个无关僵留基线）**≥ 3** ✓；全文件峰值 17（应用自有 16，22:27:35.184）。刷新墙钟 = `log` 起 22:19:32.197323 + perf `0.500947300 s` → 22:19:32.698270 = **501 ms**，其余 9 条命令的启动时间戳全部落在该窗口内。
- [x] 端到端：切分支进行中再点提交 → **排队**，无 git lock 报错。（控制器联合端到端验收时勾选 —— ledger 裁决 R2）
      → 控制器联合端到端验收（ledger 裁决 R2）：`trace-05-switch-commit.log`：`git switch feat` 首行 **22:27:31.864546**（`run_command: .git/hooks/post-checkout` 22:27:31.884629，夹具钩子 `sleep 3`），`git commit --quiet -F -` 首行 **22:27:35.521275** = 晚于 switch 起点 **3657 ms**（提交点击在 32.4–32.9，点击后约 2.7 s 才真正 spawn ⇒ 排队）；`sample.log` 显示该段 git.exe 总数自 22:27:31.9 起连续 ≥2（含 1 个基线）直到 22:27:35.0，慢写进程全程未消失；5 个 trace 文件 **0 条 `lock` / `fatal` / `error` 行**，夹具 `.git\index.lock` 不存在。
- [x] 读命令在慢写期间不被阻塞（行为覆盖：慢写进行中发一次读，应立即返回）。（控制器联合端到端验收时勾选 —— ledger 裁决 R2；条目由来与「inspection 级别保证」的定性见 Comments「评审 1 轮整改」）
      → 控制器联合端到端验收（ledger 裁决 R2）：慢写 = `git switch feat`（22:27:31.864546 起，钩子 `sleep 3`）；慢写中发一次刷新 → 8 条读命令（status ×2 / log / stash / remote / config / for-each-ref / config）的 trace 首行为 **22:27:32.552220–32.830079**，全部落在慢写存活区间内；`sample.log` 显示读批次进程在 ~22:27:33.5 前排空，而应用自有 git 进程（2 个）继续存活到 **22:27:35.0** ⇒ 读命令在写操作仍在飞时已返回（约早 1.5 s）✓。

**Comments**

**执行记录（PowerShell 7 + cargo 1.97.1 / node v22.20.0）**

实现（`16c76f1`，只含 `src-tauri/src/commands.rs`（**+266/−126**）与 `src-tauri/src/lib.rs`（+1）两个文件；`git.rs` 一行未动，未引入 `gitdir`，无任何命令签名变更）：

- `AppState` 增 `write_lock: Arc<std::sync::Mutex<()>>`，`lib.rs` 的 `.setup()` 里初始化 `std::sync::Arc::new(std::sync::Mutex::new(()))`。
- 删除 `with_active`，换成 `active_repo` / `run_read` / `run_write` / `offload` / `offload_write` 五个助手：取激活仓库只在克隆 `GitRepo` 时持锁；读路径不抢写锁（读命令之间保持真并发）；写路径在**阻塞闭包内**抢写锁（守卫数据是 `()`，中毒用 `unwrap_or_else(|e| e.into_inner())` 恢复，不让写操作永久失败）；`spawn_blocking` 的 `JoinError` 映射为 `GitError::Io("git 任务执行失败：{e}")`。**没有任何锁跨越 `.await`**（`active_repo` 的守卫在 `?` 之前释放；`open_repo` 三处 `if let Ok(guard)` 都是块内无 await 的短临界区）。
- 53 个 git-bound 命令改 `pub async fn`：读 14 条走 `offload`、写 38 条走 `offload_write`（参数 `move` 进闭包）；`abort_operation` / `continue_operation` 先把 `parse_operation` 这个纯字符串映射做掉再入池。
- `open_repo` 单独处理：`GitRepo::open` + `git::repo_meta` 入阻塞池，回到 async 上下文依次改 `active` / 重绑 `repo_watcher` / `touch_recent` + `save_config`。
- `commands.rs` 末尾新增 `#[cfg(test)] mod tests`（本票规定的 2 个用例逐字落地；`dummy_repo()` 按当前 `GitRepo { root }` 单字段构造）。

命令计数（实测）：`#[tauri::command]` = **57**、`pub async fn` = **53**、`fn with_active` = **0**；未入池的 5 个 = 4 个不碰 git 的同步命令（`get_app_config` / `set_theme` / `remove_recent` / `open_file_in_editor`）+ `open_repo`（自带 `spawn_blocking`）。另用脚本按 `#[tauri::command]` 切块抽取每个命令体内实际调用的 helper 复核：读 14 / 写 38 两个集合与本票「分类」清单**逐条一致**。

测试证据：

- `cargo build`（`src-tauri/`）：`Finished dev profile [unoptimized + debuginfo] target(s) in 18.10s`，**0 warning**，退出码 0。
- `cargo test -- --test-threads=1`（`src-tauri/`）：`test result: ok. 57 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 234.62s`（既有 55 条用例一行未改）。
- `pnpm test`：`Test Files 7 passed (7)` / `Tests 164 passed (164)`，与基线 `5c5b669` 相同。
- `pnpm build`：`$ tsc && vite build` → `✓ 1938 modules transformed` → `✓ built in 1.54s`，退出码 0（前端零改动仍过 tsc ⇒ IPC 契约未变）。
- 签名等价（机械比对，作为上一条的正向证据）：从改造前后两个版本各抽取 57 个 `pub [async] fn` 的「函数名 + 参数表（空白与尾逗号归一）+ 返回类型」做 `Compare-Object` → **无差异**，即命令名 / 参数名 / 参数类型 / 返回类型逐条相同（唯一区别是 `async` 关键字）。
- `git show --stat HEAD` = `2 files changed, 267 insertions(+), 126 deletions(-)`（= `commands.rs` 的 +266/−126 与 `lib.rs` 的 +1 之和）；`git diff --check HEAD~1 HEAD` 无输出（无空白/行尾问题）；工作区文件仍为 CRLF，与仓库其余文件一致，**无行尾重写**。

**反向验证（裁决 R3；破坏态未提交）**

把 `run_write` 里的 `let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());` 临时换成 `let _guard = lock;`（不抢锁），`cargo test --lib commands::` 输出：

```
test commands::tests::read_is_not_blocked_by_write_lock ... ok
test commands::tests::write_lock_serializes_overlapping_writes ... FAILED

---- commands::tests::write_lock_serializes_overlapping_writes stdout ----
thread 'commands::tests::write_lock_serializes_overlapping_writes' (18172) panicked at src\commands.rs:573:9:
写操作没有被串行化：151.0271ms
test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 56 filtered out; finished in 0.15s
```

（真并行 151ms < 290ms 阈值 ⇒ 用例确实测到「抢锁」这一行为。`read_is_not_blocked_by_write_lock` 在破坏态下仍绿是预期的：它只锁「读不被写锁阻塞」这一条不变量。）随即恢复原行并重跑：

```
test commands::tests::read_is_not_blocked_by_write_lock ... ok
test commands::tests::write_lock_serializes_overlapping_writes ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 56 filtered out; finished in 0.30s
```

恢复后文件逐字节回到破坏前状态，破坏态从未 `git add`，`16c76f1` 只含最终版本。

**唯一披露的偏差**：本票代码段里的助手用到 `GitResult<T>`，但 `commands.rs` 原本只导入 `GitError`（`use crate::git::{self, BranchSummary, CommitDetail, GitError, GitRepo, LogPage, RepoMeta, RepoStatus}`）。首次 `cargo build` 因此报 2 处 `E0425: cannot find type GitResult`（都在 `F: FnOnce(&GitRepo) -> GitResult<T>` 约束上）；在导入列表补 `GitResult` 后即 0 warning 通过，其余实现与本票代码段逐字一致。

既有事实（不在本票范围，无动作）：`cargo fmt --check` 显示仓库整体不是 rustfmt-clean（本文件相关 crate 内 `commands.rs` 4 处 Diff、`git.rs` 多处），仓库无 `rustfmt.toml`、无 fmt 门禁，故不做格式化波及以免越界改动。

提交：`16c76f1`（`feat(ipc): git 命令改 async + spawn_blocking 并引入仓库写锁（工单 01）`），只含上述两个源文件；本工单文本随后以 `docs(tickets)` 提交收口。

**评审 1 轮整改（1 Important + 1 记账 Minor）**

评审结论：**Spec ✅ compliant / Task quality Approved**。评审独立确认了 57 个签名逐条 byte-identical、无 `MutexGuard` 跨 `.await`，并判定 `GitResult` 导入是正确取舍。以下是当时唯一未结项，已全部整改。

1. **Important —— `commands.rs:581-593` 的 `read_is_not_blocked_by_write_lock` 不可能失败**（评审原话要点）：该用例在 :582 建了一个**局部** mutex、从未交给生产读路径，断言对象只是 `run_read(dummy_repo(), |_| Ok(42))`；于是「读路径不抢写锁」这条不变量若被破坏（例如把 `offload` 改成去抢 `state.write_lock`），整套测试仍会全绿 —— 唯一能变红的途径是签名变化（编译错误，不是行为断言）。我自己的 R3 破坏态里该用例确实仍绿，这正是征兆。**结论：finding 成立，不辩解、不归因于 plan-mandated。**

   按控制器裁决的第一种补救（只动测试，生产路径一字未改）：

   - 用例改名为 **`read_completes_while_write_lock_is_held`** —— 名字说它真正验证的东西；
   - **让前提变成真的**：在 `rx.recv_timeout(...)` 返回之后、`drop(guard)` 之前加 `assert!(lock.try_lock().is_err(), "写锁在读命令返回前已被释放，本用例的前提不成立")`。原来的写法里没有任何东西校验守卫活过了那次读 —— 守卫若提前释放，`assert_eq!(got.unwrap(), 42)` 就是空转；
   - 用例上方加 doc comment 写明**诚实范围**：这是文档级用例，**不能**否证「`offload` 去抢 `write_lock`」这类回归。
   - **剩余保证的定性（明写）**：「`offload` 永不获取 `write_lock`」是 **inspection 级别**的保证 —— 全文件唯一的 `Arc::clone(&state.write_lock)` 出现在 `offload_write` 里；它的**行为覆盖**由控制器联合端到端验收负责，对应当前新增的那条验收条目「读命令在慢写期间不被阻塞（慢写进行中发一次读，应立即返回）」。不伪造 AppState 级测试，也不声称本用例证明了 `offload` 无锁。

2. **Minor（记账笔误，已更正）**：本文 Comments 原写 `src-tauri/src/commands.rs（+265/−125）`，真实数字是 **+266/−126**（`16c76f1` 的 `2 files changed, 267 insertions(+), 126 deletions(-)` 含 `lib.rs` 的 +1）。上面「实现」那段与「`git show --stat HEAD`」那一条已按此更正。

验证（本轮只改测试，按指示只跑覆盖用例与构建，未重跑全套）：

```
$ cargo test --lib commands:: -- --test-threads=1
running 2 tests
test commands::tests::read_completes_while_write_lock_is_held ... ok
test commands::tests::write_lock_serializes_overlapping_writes ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 56 filtered out; finished in 0.30s
$ cargo build
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 10.03s
```

（`cargo build` 0 warning；两条命令 `$LASTEXITCODE` 均为 0。）

改动范围：`src-tauri/src/commands.rs` **仅测试模块**（`git diff 16c76f1 -- src-tauri/src/commands.rs` = `1 file changed, 13 insertions(+), 1 deletion(-)`，全部落在 `mod tests` 内）+ 本工单文件。**未动** `src-tauri/src/lib.rs`、`src-tauri/src/git.rs`，无任何生产代码路径改动。

提交：本轮整改 = **`bbf417b`**（`test(ipc): 读锁用例改名 read_completes_while_write_lock_is_held 并断言真实前提（评审 1 轮）`，只含 `src-tauri/src/commands.rs`）；本工单文本随其后的 `docs(tickets)` 提交收口（工单要写下本轮的 commit hash，故拆成两个提交，两次都只 stage 了测试文件 / 工单文件，没有第三个文件入账）。

**联合端到端验收（控制器，2026-10-13）**

观测方法（**零代码改动**，原始文件在 `<PI_SCRATCH_DIR>\e2e\`）：

- 启动应用前在**进程环境**里设 `GIT_TRACE=<file>` / `GIT_TRACE_PERFORMANCE=<file>`：每个应用派生的 git 子进程向同一文件追加 `trace: built-in: git <args>`（启动）与 `performance: N s: git command: ...`（结束 + 耗时）两行 —— `spawn_git` 不改子进程环境，故这些行只可能来自应用派生的 git（`trace-0*.log` / `perf-0*.log`）。
- 后台循环每 ~40–60 ms 采样 `(Get-Process git).Count` 与 `(Get-Process fumi-git).Responding`，写 `sample.log`（CSV `ts_ms,gits,fumi_pids,fumi_responding`）。**控制器最终读数（采样器已停）**：全文件 **629,497 行 / 跨度 39,318,023 ms**，其中应用存活段（`ts_ms` ≤ 38,980,655）**624,303 行、`fumi_responding` 全部为 `True`、0 条例外**；`ts_ms` = 38,980,734 起 5,194 行为 `gone`（应用 pid 41680 退出；退出点在全部验收场景结束之后 —— 证据窗口 `ts_ms` ≤ 542,406）。窗口对齐用 `ts_ms`（±0.3 s，绝对锚点取 22:19:32.2 的刷新峰值）。
- **诚实披露（方法替代）**：走查期间**会话处于锁定状态**（`LockApp.exe` + `LogonUI.exe` 占前台，`WScript.Shell.AppActivate` 返回 True 但前台窗口不变）→ 真实鼠标 / 键盘输入不可投递。UI 交互改经**应用自身 WebView2 的远程调试端口**（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`）用 `Runtime.evaluate(userGesture:true)` 驱动（`q*.js` + `cdp.mjs`）—— 走同一批 DOM 处理器与同一条 IPC 路径（`ipc.*` → Tauri 命令 → `spawn_git`），且每条断言以 **git 级 trace** 为准，不以 DOM 自述为准。
- 口径：本机常驻 1 个与本应用无关的僵留 `git.exe`（pid 17260，09:25 创建、不写 trace），并发数一律按「总数 − 1 = 应用自有」折算。

四条验收项的实测：

- **01:253 不冻结**：`sample.log` 应用存活段 **624,303/624,303 `Responding=True`**（0 例外）；刷新窗口（22:19:31.8–33.2）23 条全 True；持续负载窗口（22:25:23–37）225 条全 True —— 该段 `trace-04-pagination.log` 在 12.9 s 内连发 23 次 `git log`（前 19 次 `--skip=200..22718` 集中在 9.91 s）；交互窗口（`ts_ms` 560000–582000）481 条全 True、`gits` ∈ {1,2,3} 峰值 3（`git-trace.log`：该窗口 2 条 `log` 在飞，perf 0.4642 / 0.4389 s）。
- **01:254 ≥3 并发**：10 个应用自有 git 子进程（`trace-01`）/ `sample.log` 峰值 11（应用自有 10）≥ 3。
- **01:255 写排队**：switch 22:27:31.864546 → commit 22:27:35.521275（+3657 ms）；无 lock 报错、无 `index.lock`。
- **01:256 读不被写阻塞**：8 条读命令 trace 首行 22:27:32.552220–32.830079 全在慢写存活区间内；读批次 ~33.5 前排空，写进程存活到 ~35.0。

已知边界 / 未覆盖项：

- 原生窗口拖动、真实鼠标 / 键盘路径未实测（会话锁定；键盘路径只做了 DOM 侧可聚焦序确认）。
- **22:27 那一轮的 `GIT_TRACE_PERFORMANCE` 输出不在证据集里**（`e2e\\` 只有 `perf-01-open.log` / `perf-02-light.log` / `perf-04-pagination.log` 与 22:29 的 `git-perf.log`）⇒ 证据汇总里的「`git switch feat` perf **3.3376 s**（收于 22:27:35.200）」与「长杆 `log`（`--max-count=69327`，0.859 s）收于 **22:27:33.478**」这两处精确数字**无法用原始文件复核**（当时是实时输出、未另存文件）；本工单的勾选依据是 trace 首行时间戳 + `sample.log` 进程计数（结论不变：读在写仍在飞时返回、提交晚于 switch 起点 3.66 s）。
- 夹具内 `post-checkout`（`sleep 3`）按计划在走查后删除，内容无法再复核；`trace-05` 第 5 行仍留 `run_command: .git/hooks/post-checkout 135eb78eaa4bb614df3570742887201d558d360b 15ff049dc6c8990877d819c5731a83e85a080555 1` 的调用记录。
- CDP 交互脚本的**返回值**（tab 激活类名迁移、`scrollTop 3604282 → 3602282`、点击 → 收尾 985 ms）未落盘，只存在于证据汇总 `e2e-evidence.md`；本工单只为其中可复核的部分（进程计数 / 可交互性采样 / git trace）背书。
- 证据汇总的「1752 条样本」是控制器当时的中途读数（局部计数）：采样器实际又跑了 10.7 小时才被控制器停止，最终全量 **629,497 行 / 跨度 39,318,023 ms** —— 应用存活段 624,303 行全部 `True`，其后 5,194 行 `gone` 因应用退出。「全部 `Responding=True`」按全量文件成立且更强。
- 夹具规模（`rev-list --count --all` = 100001）未独立复算：本工单禁止运行任何 git 命令（避免与并行子代理争 `index.lock`）；间接一致性：`trace-04` 的 `log` 窗口已推进到 `--skip=55462`，22:29 的窗口到 `--skip=86658 --max-count=21664`（86658 + 21664 = 108322 > 100001）。
