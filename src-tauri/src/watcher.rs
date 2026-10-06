//! `.git` 目录监听：外部（终端、其它工具）改动仓库后自动通知前端刷新。
//! 防抖策略：500ms 窗口内只发一次事件。

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(500);

pub fn start(app: &AppHandle, root: &Path) -> notify::Result<RecommendedWatcher> {
    let app = app.clone();
    let last_emit = Mutex::new(Instant::now() - DEBOUNCE);
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if res.is_err() {
            return;
        }
        let mut last = match last_emit.lock() {
            Ok(l) => l,
            Err(_) => return,
        };
        if last.elapsed() >= DEBOUNCE {
            *last = Instant::now();
            let _ = app.emit("repo-changed", ());
        }
    })?;
    watcher.watch(&root.join(".git"), RecursiveMode::Recursive)?;
    watcher.watch(root, RecursiveMode::NonRecursive)?;
    Ok(watcher)
}
