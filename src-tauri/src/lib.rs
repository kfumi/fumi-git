mod commands;
mod config;
mod git;
mod watcher;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let config_path = dir.join("config.json");
            let cfg = config::load(&config_path);
            app.manage(commands::AppState {
                config_path,
                config: std::sync::Mutex::new(cfg),
                active: std::sync::Mutex::new(None),
                repo_watcher: std::sync::Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_config,
            commands::set_theme,
            commands::open_repo,
            commands::remove_recent,
            commands::get_log,
            commands::get_commit_detail,
            commands::get_status,
            commands::get_worktree_diff,
            commands::stage_paths,
            commands::unstage_paths,
            commands::commit_staged,
            commands::fetch_remote,
            commands::pull_remote,
            commands::push_remote,
            commands::get_branch_summary,
            commands::switch_branch,
            commands::stash_push,
            commands::create_branch,
            commands::delete_branch,
            commands::branch_unmerged_count,
            commands::rename_branch,
            commands::reset_branch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
