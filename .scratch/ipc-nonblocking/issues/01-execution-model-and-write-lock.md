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

- [ ] `cargo build` 通过；`cargo test -- --test-threads=1` 全绿（既有用例一行未改）
- [ ] 新增 2 个用例通过，且**反向验证有效**：临时删掉 `run_write` 里的抢锁 → `write_lock_serializes_overlapping_writes` 变红
- [ ] `#[tauri::command]` 数量仍为 57，其中 `async fn` = 53（4 个 config 命令保持同步），`with_active` 已消失
- [ ] 命令名 / 参数名 / 返回类型与改造前逐一相同（前端零改动 + `pnpm build` 的 tsc 通过即为证）
- [ ] 端到端：10 万提交夹具下触发刷新 → 窗口可拖动、可切 tab、可滚动，**不出现 Windows「无响应」**
- [ ] 端到端：刷新期间 `Get-Process git` 观测到 **≥3 个 git.exe 并发存在**
- [ ] 端到端：切分支进行中再点提交 → **排队**，无 git lock 报错

**Comments**

（执行时回填：验收观测值、commit hash）
