//! Tauri 命令层：前端唯一可触达的 IPC 面。所有命令围绕「当前激活仓库」工作。

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, State};

use crate::config::{self, AppConfig};
use crate::git::{
    self, BranchSummary, CommitDetail, GitError, GitRepo, LogPage, RepoMeta, RepoStatus,
};
use crate::watcher;

pub struct AppState {
    pub config_path: PathBuf,
    pub config: Mutex<AppConfig>,
    pub active: Mutex<Option<GitRepo>>,
    /// 切换仓库时 drop 旧 watcher 即停止监听
    pub repo_watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

fn with_active<T>(
    state: &AppState,
    f: impl FnOnce(&GitRepo) -> Result<T, GitError>,
) -> Result<T, GitError> {
    // 只在取引用时持锁：GitRepo 是廉价克隆（一个 PathBuf），
    // 慢命令（fetch/pull/push）期间不得阻塞其它命令的数据面。
    let repo = {
        let guard = state
            .active
            .lock()
            .map_err(|_| GitError::Io("状态锁中毒".into()))?;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| GitError::NotARepo("尚未打开任何仓库".into()))?
    };
    f(&repo)
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
pub fn open_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<RepoMeta, GitError> {
    let repo = GitRepo::open(std::path::Path::new(&path))?;
    let meta = git::repo_meta(&repo);

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
pub fn get_log(state: State<'_, AppState>, skip: usize, limit: usize) -> Result<LogPage, GitError> {
    with_active(&state, |repo| git::get_log(repo, skip, limit))
}

#[tauri::command]
pub fn get_commit_detail(
    state: State<'_, AppState>,
    hash: String,
) -> Result<CommitDetail, GitError> {
    with_active(&state, |repo| git::get_commit_detail(repo, &hash))
}

#[tauri::command]
pub fn get_status(state: State<'_, AppState>) -> Result<RepoStatus, GitError> {
    with_active(&state, git::get_status)
}

#[tauri::command]
pub fn get_worktree_diff(
    state: State<'_, AppState>,
    staged: bool,
    path: String,
) -> Result<String, GitError> {
    with_active(&state, |repo| git::worktree_diff(repo, staged, &path))
}

#[tauri::command]
pub fn stage_paths(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), GitError> {
    with_active(&state, |repo| git::stage(repo, &paths))
}

#[tauri::command]
pub fn unstage_paths(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), GitError> {
    with_active(&state, |repo| git::unstage(repo, &paths))
}

#[tauri::command]
pub fn commit_staged(state: State<'_, AppState>, message: String) -> Result<String, GitError> {
    with_active(&state, |repo| git::commit(repo, &message))
}

#[tauri::command]
pub fn fetch_remote(state: State<'_, AppState>) -> Result<String, GitError> {
    with_active(&state, git::fetch)
}

#[tauri::command]
pub fn pull_remote(state: State<'_, AppState>) -> Result<String, GitError> {
    with_active(&state, git::pull)
}

#[tauri::command]
pub fn push_remote(state: State<'_, AppState>) -> Result<String, GitError> {
    with_active(&state, git::push)
}

#[tauri::command]
pub fn push_upstream(
    state: State<'_, AppState>,
    remote: String,
    branch: String,
) -> Result<String, GitError> {
    with_active(&state, |repo| git::push_upstream(repo, &remote, &branch))
}

#[tauri::command]
pub fn list_remotes(state: State<'_, AppState>) -> Result<Vec<String>, GitError> {
    with_active(&state, git::list_remotes)
}

#[tauri::command]
pub fn merge_upstream(state: State<'_, AppState>, ref_name: String) -> Result<String, GitError> {
    with_active(&state, |repo| git::merge_ref(repo, &ref_name))
}

#[tauri::command]
pub fn abort_operation(state: State<'_, AppState>, op: String) -> Result<(), GitError> {
    let op = match op.as_str() {
        "merge" => git::Operation::Merge,
        "cherry-pick" => git::Operation::CherryPick,
        "revert" => git::Operation::Revert,
        other => return Err(GitError::CommandFailed(format!("非法操作类型：{other}"))),
    };
    with_active(&state, |repo| git::abort_operation(repo, op))
}

#[tauri::command]
pub fn conflict_versions(
    state: State<'_, AppState>,
    path: String,
) -> Result<git::ConflictVersions, GitError> {
    with_active(&state, |repo| git::conflict_versions(repo, &path))
}

#[tauri::command]
pub fn read_worktree_file(state: State<'_, AppState>, path: String) -> Result<String, GitError> {
    with_active(&state, |repo| git::read_worktree_file(repo, &path))
}

#[tauri::command]
pub fn write_worktree_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), GitError> {
    with_active(&state, |repo| git::write_worktree_file(repo, &path, &content))
}

#[tauri::command]
pub fn resolve_take(
    state: State<'_, AppState>,
    path: String,
    ours: bool,
) -> Result<(), GitError> {
    with_active(&state, |repo| git::resolve_take(repo, &path, ours))
}

#[tauri::command]
pub fn continue_operation(state: State<'_, AppState>, op: String) -> Result<String, GitError> {
    let op = match op.as_str() {
        "merge" => git::Operation::Merge,
        "cherry-pick" => git::Operation::CherryPick,
        "revert" => git::Operation::Revert,
        other => return Err(GitError::CommandFailed(format!("非法操作类型：{other}"))),
    };
    with_active(&state, |repo| git::continue_operation(repo, op))
}

#[tauri::command]
pub fn open_file_in_editor(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn revert_commit(state: State<'_, AppState>, hash: String) -> Result<String, GitError> {
    with_active(&state, |repo| git::revert_commit(repo, &hash))
}

#[tauri::command]
pub fn cherry_pick(state: State<'_, AppState>, hash: String) -> Result<String, GitError> {
    with_active(&state, |repo| git::cherry_pick(repo, &hash))
}

#[tauri::command]
pub fn cherry_pick_skip(state: State<'_, AppState>) -> Result<(), GitError> {
    with_active(&state, git::cherry_pick_skip)
}

#[tauri::command]
pub fn get_branch_summary(state: State<'_, AppState>) -> Result<BranchSummary, GitError> {
    with_active(&state, git::get_branch_summary)
}

#[tauri::command]
pub fn switch_branch(state: State<'_, AppState>, name: String) -> Result<(), GitError> {
    with_active(&state, |repo| git::switch_branch(repo, &name))
}

#[tauri::command]
pub fn stash_push(
    state: State<'_, AppState>,
    message: Option<String>,
) -> Result<(), GitError> {
    with_active(&state, |repo| git::stash_push(repo, message.as_deref()))
}

#[tauri::command]
pub fn stash_list(state: State<'_, AppState>) -> Result<Vec<git::StashEntry>, GitError> {
    with_active(&state, git::stash_list)
}

#[tauri::command]
pub fn stash_diff(state: State<'_, AppState>, index: u32) -> Result<String, GitError> {
    with_active(&state, |repo| git::stash_diff(repo, index))
}

#[tauri::command]
pub fn stash_apply(state: State<'_, AppState>, index: u32, pop: bool) -> Result<(), GitError> {
    with_active(&state, |repo| git::stash_apply(repo, index, pop))
}

#[tauri::command]
pub fn stash_drop(state: State<'_, AppState>, index: u32) -> Result<(), GitError> {
    with_active(&state, |repo| git::stash_drop(repo, index))
}

#[tauri::command]
pub fn discard_worktree(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), GitError> {
    with_active(&state, |repo| git::discard_worktree(repo, &paths))
}

#[tauri::command]
pub fn delete_untracked(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), GitError> {
    with_active(&state, |repo| git::delete_untracked(repo, &paths))
}

#[tauri::command]
pub fn discard_staged(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), GitError> {
    with_active(&state, |repo| git::discard_staged(repo, &paths))
}

#[tauri::command]
pub fn discard_staged_new(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), GitError> {
    with_active(&state, |repo| git::discard_staged_new(repo, &paths))
}

#[tauri::command]
pub fn discard_all(state: State<'_, AppState>) -> Result<(), GitError> {
    with_active(&state, git::discard_all)
}

#[tauri::command]
pub fn create_branch(
    state: State<'_, AppState>,
    name: String,
    checkout: bool,
    start_point: Option<String>,
) -> Result<(), GitError> {
    with_active(&state, |repo| {
        git::create_branch(repo, &name, checkout, start_point.as_deref())
    })
}

#[tauri::command]
pub fn reset_branch(
    state: State<'_, AppState>,
    target: String,
    mode: String,
) -> Result<(), GitError> {
    with_active(&state, |repo| git::reset_branch(repo, &target, &mode))
}

#[tauri::command]
pub fn delete_branch(
    state: State<'_, AppState>,
    name: String,
    force: bool,
) -> Result<(), GitError> {
    with_active(&state, |repo| git::delete_branch(repo, &name, force))
}

#[tauri::command]
pub fn branch_unmerged_count(state: State<'_, AppState>, name: String) -> Result<u32, GitError> {
    with_active(&state, |repo| git::branch_unmerged_count(repo, &name))
}

#[tauri::command]
pub fn rename_branch(
    state: State<'_, AppState>,
    old: String,
    new: String,
) -> Result<(), GitError> {
    with_active(&state, |repo| git::rename_branch(repo, &old, &new))
}
