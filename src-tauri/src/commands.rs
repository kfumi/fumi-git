//! Tauri 命令层：前端唯一可触达的 IPC 面。所有命令围绕「当前激活仓库」工作。

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

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
pub fn get_branch_summary(state: State<'_, AppState>) -> Result<BranchSummary, GitError> {
    with_active(&state, git::get_branch_summary)
}
