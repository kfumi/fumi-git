//! Tauri 命令层：前端唯一可触达的 IPC 面。所有命令围绕「当前激活仓库」工作。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, State};

use crate::config::{self, AppConfig};
use crate::git::{
    self, BranchSummary, CommitDetail, GitError, GitRepo, GitResult, LogPage, RepoMeta, RepoStatus,
};
use crate::watcher;

pub struct AppState {
    pub config_path: PathBuf,
    pub config: Mutex<AppConfig>,
    pub active: Mutex<Option<GitRepo>>,
    /// 切换仓库时 drop 旧 watcher 即停止监听
    pub repo_watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// 写操作串行化：异步化后主线程不再冻结，前端 writeBusy 挡不住已排队的调用
    pub write_lock: Arc<std::sync::Mutex<()>>,
}

/// operation 字符串 → 枚举（abort/continue 共用）
fn parse_operation(op: &str) -> Result<git::Operation, GitError> {
    match op {
        "merge" => Ok(git::Operation::Merge),
        "cherry-pick" => Ok(git::Operation::CherryPick),
        "revert" => Ok(git::Operation::Revert),
        "rebase" => Ok(git::Operation::Rebase),
        other => Err(GitError::CommandFailed(format!("非法操作类型：{other}"))),
    }
}

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

fn save_config(state: &AppState) {
    if let Ok(cfg) = state.config.lock() {
        config::save(&state.config_path, &cfg);
    }
}

#[tauri::command]
pub fn get_app_config(state: State<'_, AppState>) -> AppConfig {
    state.config.lock().map(|c| c.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn set_theme(state: State<'_, AppState>, mode: String) -> Result<(), String> {
    if !matches!(mode.as_str(), "dark" | "light" | "system") {
        return Err(format!("非法主题：{mode}"));
    }
    if let Ok(mut cfg) = state.config.lock() {
        cfg.theme = mode;
    }
    save_config(&state);
    Ok(())
}

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
    // 换绑监听
    if let Ok(mut slot) = state.repo_watcher.lock() {
        *slot = watcher::start(&app, &repo.root).ok();
    }
    // 更新最近列表
    if let Ok(mut cfg) = state.config.lock() {
        config::touch_recent(&mut cfg, &meta.path, &meta.name);
    }
    save_config(&state);
    Ok(meta)
}

#[tauri::command]
pub fn remove_recent(state: State<'_, AppState>, path: String) {
    if let Ok(mut cfg) = state.config.lock() {
        cfg.recent_repos.retain(|e| e.path != path);
    }
    save_config(&state);
}

#[tauri::command]
pub async fn get_log(
    state: State<'_, AppState>,
    skip: usize,
    limit: usize,
    filter: Option<git::LogFilter>,
) -> Result<LogPage, GitError> {
    let filter = filter.unwrap_or_default();
    offload(state, move |repo| {
        git::get_log_filtered(repo, skip, limit, &filter)
    })
    .await
}

/// 本仓库的提交身份（user.name / user.email），供「只看我的」筛选
#[tauri::command]
pub async fn get_user_identity(state: State<'_, AppState>) -> Result<git::UserIdentity, GitError> {
    offload(state, |repo| Ok(git::get_user_identity(repo))).await
}

#[tauri::command]
pub async fn get_commit_detail(
    state: State<'_, AppState>,
    hash: String,
) -> Result<CommitDetail, GitError> {
    offload(state, move |repo| git::get_commit_detail(repo, &hash)).await
}

#[tauri::command]
pub async fn get_status(state: State<'_, AppState>) -> Result<RepoStatus, GitError> {
    offload(state, git::get_status).await
}

#[tauri::command]
pub async fn get_worktree_diff(
    state: State<'_, AppState>,
    staged: bool,
    path: String,
) -> Result<String, GitError> {
    offload(state, move |repo| git::worktree_diff(repo, staged, &path)).await
}

#[tauri::command]
pub async fn stage_paths(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), GitError> {
    offload_write(state, move |repo| git::stage(repo, &paths)).await
}

#[tauri::command]
pub async fn unstage_paths(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), GitError> {
    offload_write(state, move |repo| git::unstage(repo, &paths)).await
}

#[tauri::command]
pub async fn commit_staged(state: State<'_, AppState>, message: String) -> Result<String, GitError> {
    offload_write(state, move |repo| git::commit(repo, &message)).await
}

#[tauri::command]
pub async fn fetch_remote(
    state: State<'_, AppState>,
    remote: Option<String>,
) -> Result<String, GitError> {
    offload_write(state, move |repo| git::fetch(repo, remote.as_deref())).await
}

#[tauri::command]
pub async fn pull_remote(state: State<'_, AppState>) -> Result<String, GitError> {
    offload_write(state, git::pull).await
}

#[tauri::command]
pub async fn push_remote(state: State<'_, AppState>) -> Result<String, GitError> {
    offload_write(state, git::push).await
}

#[tauri::command]
pub async fn push_upstream(
    state: State<'_, AppState>,
    remote: String,
    branch: String,
) -> Result<String, GitError> {
    offload_write(state, move |repo| git::push_upstream(repo, &remote, &branch)).await
}

#[tauri::command]
pub async fn push_to(
    state: State<'_, AppState>,
    remote: String,
    branch: String,
) -> Result<String, GitError> {
    offload_write(state, move |repo| git::push_to(repo, &remote, &branch)).await
}

#[tauri::command]
pub async fn push_all_remotes(
    state: State<'_, AppState>,
    branch: String,
) -> Result<String, GitError> {
    offload_write(state, move |repo| git::push_all_remotes(repo, &branch)).await
}

#[tauri::command]
pub async fn list_remotes(state: State<'_, AppState>) -> Result<Vec<String>, GitError> {
    offload(state, git::list_remotes).await
}

/// 全量引用（分支 / 标签 / 远程 ref）。与 get_log 的分页无关，侧栏据此展示全部引用。
#[tauri::command]
pub async fn list_refs(state: State<'_, AppState>) -> Result<Vec<git::RefEntry>, GitError> {
    offload(state, git::list_refs).await
}

#[tauri::command]
pub async fn merge_upstream(
    state: State<'_, AppState>,
    ref_name: String,
) -> Result<String, GitError> {
    offload_write(state, move |repo| git::merge_ref(repo, &ref_name)).await
}

#[tauri::command]
pub async fn abort_operation(state: State<'_, AppState>, op: String) -> Result<(), GitError> {
    // parse_operation 只是字符串映射，不需要进阻塞池
    let op = parse_operation(&op)?;
    offload_write(state, move |repo| git::abort_operation(repo, op)).await
}

#[tauri::command]
pub async fn conflict_versions(
    state: State<'_, AppState>,
    path: String,
) -> Result<git::ConflictVersions, GitError> {
    offload(state, move |repo| git::conflict_versions(repo, &path)).await
}

#[tauri::command]
pub async fn read_worktree_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, GitError> {
    offload(state, move |repo| git::read_worktree_file(repo, &path)).await
}

#[tauri::command]
pub async fn write_worktree_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), GitError> {
    offload_write(state, move |repo| {
        git::write_worktree_file(repo, &path, &content)
    })
    .await
}

#[tauri::command]
pub async fn resolve_take(
    state: State<'_, AppState>,
    path: String,
    ours: bool,
) -> Result<(), GitError> {
    offload_write(state, move |repo| git::resolve_take(repo, &path, ours)).await
}

#[tauri::command]
pub async fn continue_operation(
    state: State<'_, AppState>,
    op: String,
    action: Option<String>,
) -> Result<String, GitError> {
    // parse_operation 只是字符串映射，不需要进阻塞池
    let op = parse_operation(&op)?;
    offload_write(state, move |repo| {
        git::continue_operation(repo, op, action.as_deref())
    })
    .await
}

#[tauri::command]
pub fn open_file_in_editor(path: String) -> Result<(), GitError> {
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|e| GitError::Io(e.to_string()))
}

#[tauri::command]
pub async fn revert_commit(state: State<'_, AppState>, hash: String) -> Result<String, GitError> {
    offload_write(state, move |repo| git::revert_commit(repo, &hash)).await
}

#[tauri::command]
pub async fn cherry_pick(state: State<'_, AppState>, hash: String) -> Result<String, GitError> {
    offload_write(state, move |repo| git::cherry_pick(repo, &hash)).await
}

#[tauri::command]
pub async fn cherry_pick_skip(state: State<'_, AppState>) -> Result<(), GitError> {
    offload_write(state, git::cherry_pick_skip).await
}

#[tauri::command]
pub async fn cherry_pick_keep(state: State<'_, AppState>) -> Result<String, GitError> {
    offload_write(state, git::cherry_pick_keep).await
}

#[tauri::command]
pub async fn get_branch_summary(state: State<'_, AppState>) -> Result<BranchSummary, GitError> {
    offload(state, git::get_branch_summary).await
}

#[tauri::command]
pub async fn switch_branch(state: State<'_, AppState>, name: String) -> Result<(), GitError> {
    offload_write(state, move |repo| git::switch_branch(repo, &name)).await
}

#[tauri::command]
pub async fn stash_push(
    state: State<'_, AppState>,
    message: Option<String>,
) -> Result<(), GitError> {
    offload_write(state, move |repo| git::stash_push(repo, message.as_deref())).await
}

#[tauri::command]
pub async fn stash_list(state: State<'_, AppState>) -> Result<Vec<git::StashEntry>, GitError> {
    offload(state, git::stash_list).await
}

#[tauri::command]
pub async fn stash_diff(state: State<'_, AppState>, index: u32) -> Result<String, GitError> {
    offload(state, move |repo| git::stash_diff(repo, index)).await
}

#[tauri::command]
pub async fn stash_apply(
    state: State<'_, AppState>,
    index: u32,
    pop: bool,
) -> Result<(), GitError> {
    offload_write(state, move |repo| git::stash_apply(repo, index, pop)).await
}

#[tauri::command]
pub async fn stash_drop(state: State<'_, AppState>, index: u32) -> Result<(), GitError> {
    offload_write(state, move |repo| git::stash_drop(repo, index)).await
}

#[tauri::command]
pub async fn discard_worktree(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<(), GitError> {
    offload_write(state, move |repo| git::discard_worktree(repo, &paths)).await
}

#[tauri::command]
pub async fn delete_untracked(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<(), GitError> {
    offload_write(state, move |repo| git::delete_untracked(repo, &paths)).await
}

#[tauri::command]
pub async fn discard_staged(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<(), GitError> {
    offload_write(state, move |repo| git::discard_staged(repo, &paths)).await
}

#[tauri::command]
pub async fn discard_staged_new(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<(), GitError> {
    offload_write(state, move |repo| git::discard_staged_new(repo, &paths)).await
}

#[tauri::command]
pub async fn discard_all(state: State<'_, AppState>) -> Result<(), GitError> {
    offload_write(state, git::discard_all).await
}

#[tauri::command]
pub async fn create_branch(
    state: State<'_, AppState>,
    name: String,
    checkout: bool,
    start_point: Option<String>,
) -> Result<(), GitError> {
    offload_write(state, move |repo| {
        git::create_branch(repo, &name, checkout, start_point.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn reset_branch(
    state: State<'_, AppState>,
    target: String,
    mode: String,
) -> Result<(), GitError> {
    offload_write(state, move |repo| git::reset_branch(repo, &target, &mode)).await
}

#[tauri::command]
pub async fn delete_branch(
    state: State<'_, AppState>,
    name: String,
    force: bool,
) -> Result<(), GitError> {
    offload_write(state, move |repo| git::delete_branch(repo, &name, force)).await
}

#[tauri::command]
pub async fn branch_unmerged_count(
    state: State<'_, AppState>,
    name: String,
) -> Result<u32, GitError> {
    offload(state, move |repo| git::branch_unmerged_count(repo, &name)).await
}

#[tauri::command]
pub async fn rename_branch(
    state: State<'_, AppState>,
    old: String,
    new: String,
) -> Result<(), GitError> {
    offload_write(state, move |repo| git::rename_branch(repo, &old, &new)).await
}

#[tauri::command]
pub async fn delete_remote_branch(
    state: State<'_, AppState>,
    remote: String,
    branch: String,
) -> Result<String, GitError> {
    offload_write(state, move |repo| {
        git::delete_remote_branch(repo, &remote, &branch)
    })
    .await
}

#[tauri::command]
pub async fn set_upstream(
    state: State<'_, AppState>,
    branch: String,
    upstream: String,
) -> Result<(), GitError> {
    offload_write(state, move |repo| git::set_upstream(repo, &branch, &upstream)).await
}

#[tauri::command]
pub async fn unset_upstream(state: State<'_, AppState>, branch: String) -> Result<(), GitError> {
    offload_write(state, move |repo| git::unset_upstream(repo, &branch)).await
}

#[tauri::command]
pub async fn create_tag(
    state: State<'_, AppState>,
    name: String,
    hash: String,
    message: Option<String>,
) -> Result<(), GitError> {
    offload_write(state, move |repo| {
        git::create_tag(repo, &name, &hash, message.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn checkout_commit(state: State<'_, AppState>, hash: String) -> Result<(), GitError> {
    offload_write(state, move |repo| git::checkout_commit(repo, &hash)).await
}

#[tauri::command]
pub async fn amend_message(state: State<'_, AppState>, message: String) -> Result<(), GitError> {
    offload_write(state, move |repo| git::amend_message(repo, &message)).await
}

#[tauri::command]
pub async fn rebase(state: State<'_, AppState>, ref_name: String) -> Result<String, GitError> {
    offload_write(state, move |repo| git::rebase(repo, &ref_name)).await
}

#[tauri::command]
pub async fn get_compare(
    state: State<'_, AppState>,
    base: String,
    head: String,
) -> Result<git::CompareResult, GitError> {
    offload(state, move |repo| git::get_compare(repo, &base, &head)).await
}

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
