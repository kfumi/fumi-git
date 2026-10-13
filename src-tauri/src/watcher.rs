//! `.git` 目录监听：外部（终端、其它工具）改动仓库后自动通知前端刷新。
//! 防抖策略：尾沿 500ms —— 窗口内持续有新事件就不断延后，静默后才发一次累积分类。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(500);

/// `repo-changed` 的载荷：哪些数据面需要重拉
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct RepoChange {
    /// `.git/index` 变：暂存 / 工作区状态
    pub index: bool,
    /// `refs/**` 或 `packed-refs` 变：分支 / 标签 / 远程 ref
    pub refs: bool,
    /// `.git/HEAD` 变：当前分支或检出点
    pub head: bool,
    /// 工作区文件变（`.git` 之外的路径）
    pub worktree: bool,
}

impl RepoChange {
    /// 只有 ref / HEAD 变才可能改变提交历史视图
    #[allow(dead_code)] // 前端按同一语义分流（Rust 侧只判 is_empty）；留着当分类契约的单一来源
    pub fn needs_log(&self) -> bool {
        self.refs || self.head
    }
    pub fn is_empty(&self) -> bool {
        !(self.index || self.refs || self.head || self.worktree)
    }
    pub fn merge(&mut self, other: RepoChange) {
        self.index |= other.index;
        self.refs |= other.refs;
        self.head |= other.head;
        self.worktree |= other.worktree;
    }
}

/// 把 notify 报的路径分类。纯函数，可单测。
///
/// - `<root>/.git/index` → index
/// - `<root>/.git/refs/**`、`<root>/.git/packed-refs` → refs
/// - `<root>/.git/HEAD` → head
/// - 其它 `<root>/.git/**`（objects / logs / ORIG_HEAD / FETCH_HEAD / *.lock）→ 不置位
/// - 其余（`.git` 之外）→ worktree
pub fn classify(root: &Path, paths: &[PathBuf]) -> RepoChange {
    let git = root.join(".git");
    let mut c = RepoChange::default();
    for p in paths {
        let Ok(rel) = p.strip_prefix(&git) else {
            c.worktree = true;
            continue;
        };
        let first = rel.components().next();
        match first {
            Some(std::path::Component::Normal(name)) if name == "index" => c.index = true,
            Some(std::path::Component::Normal(name)) if name == "HEAD" => c.head = true,
            Some(std::path::Component::Normal(name)) if name == "refs" || name == "packed-refs" => {
                c.refs = true
            }
            _ => {} // objects / logs / 各类 lock 等：不改变可见数据面
        }
    }
    c
}

/// 尾沿防抖窗口里累积的待发分类
struct Pending {
    change: RepoChange,
    /// 静默到什么时候才算结束（每个新事件都往后推）
    deadline: Option<Instant>,
    /// 是否已有计时线程在跑
    armed: bool,
}

pub fn start(app: &AppHandle, root: &Path) -> notify::Result<RecommendedWatcher> {
    let app = app.clone();
    // 闭包拿走一份 root 做分类，外层另留两份给两个 watch（watch 只借 &Path）
    let watch_root = root.to_path_buf();
    let git_dir = root.join(".git");
    let worktree = root.to_path_buf();
    let pending: Arc<Mutex<Pending>> = Arc::new(Mutex::new(Pending {
        change: RepoChange::default(),
        deadline: None,
        armed: false,
    }));
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        let Ok(event) = res else { return };
        let mut p = lock_pending(&pending);
        p.change.merge(classify(&watch_root, &event.paths));
        p.deadline = Some(Instant::now() + DEBOUNCE);
        if p.armed {
            return; // 已有计时线程，它会看到被推后的 deadline
        }
        p.armed = true;
        drop(p);
        if spawn_flush(app.clone(), Arc::clone(&pending)).is_err() {
            // 计时线程起不来（资源耗尽）：这一轮的累积变更没有计时器再来发了，就地发出
            // （前置防抖的老实现也是从这个回调里 emit），否则要等下一个事件才可能被看见
            let mut p = lock_pending(&pending);
            let change = std::mem::take(&mut p.change);
            p.deadline = None;
            p.armed = false;
            drop(p);
            if !change.is_empty() {
                let _ = app.emit("repo-changed", change);
            }
        }
    })?;
    watcher.watch(&git_dir, RecursiveMode::Recursive)?;
    watcher.watch(&worktree, RecursiveMode::NonRecursive)?;
    Ok(watcher)
}

/// 取 pending 的锁。锁中毒（持锁者 panic 过）时照常取出内层数据 —— 与写锁同一约定：
/// 一次 panic 不能让外部变更通知从此静默失效（那会让 `armed` 永远停在 true）。
fn lock_pending(pending: &Mutex<Pending>) -> std::sync::MutexGuard<'_, Pending> {
    pending.lock().unwrap_or_else(|e| e.into_inner())
}

/// 尾沿防抖：窗口内持续有新事件就不断延后，静默 DEBOUNCE 后一次性发出累积分类。
///
/// 睡眠按「距 deadline 的剩余时间」算（且不持锁睡），而不是每轮固定睡 DEBOUNCE：
/// 窗口被推后时只补睡差额，emit 因此贴着 deadline 落地（最多晚调度抖动），
/// 前端的抑制窗口才留得下余量 —— 固定睡 DEBOUNCE 会让 emit 最多晚一整个防抖周期。
fn spawn_flush(app: AppHandle, pending: Arc<Mutex<Pending>>) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("repo-watch-flush".to_string())
        .spawn(move || loop {
            let wait = {
                let p = lock_pending(&pending);
                p.deadline
                    .map_or(Duration::ZERO, |d| d.saturating_duration_since(Instant::now()))
            };
            std::thread::sleep(wait);
            let mut p = lock_pending(&pending);
            let Some(deadline) = p.deadline else {
                p.armed = false; // 没有待发窗口：交还计时线程
                return;
            };
            if Instant::now() < deadline {
                continue; // 窗口被推后：下一轮只补睡差额
            }
            let change = std::mem::take(&mut p.change);
            p.deadline = None;
            p.armed = false;
            drop(p);
            // 只动了 objects / logs 之类的变更不改变任何可见数据面 → 不发事件
            if !change.is_empty() {
                let _ = app.emit("repo-changed", change);
            }
            return;
        })
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 以 `repo` 为仓库根，按相对路径分类（跨平台：一律 join，不写字面分隔符）
    fn classify_rel(rel: &[&str]) -> RepoChange {
        let root = PathBuf::from("repo");
        let paths: Vec<PathBuf> = rel.iter().map(|r| root.join(r)).collect();
        classify(&root, &paths)
    }

    #[test]
    fn index_only_touches_status() {
        let c = classify_rel(&[".git/index"]);
        assert_eq!(
            c,
            RepoChange { index: true, ..Default::default() },
            ".git/index 只置 index"
        );
        assert!(!c.needs_log(), "索引变不改变提交历史视图");
    }

    #[test]
    fn refs_dir_sets_refs() {
        let c = classify_rel(&[".git/refs/heads/main"]);
        assert_eq!(c, RepoChange { refs: true, ..Default::default() });
        assert!(c.needs_log());
    }

    #[test]
    fn packed_refs_sets_refs() {
        let c = classify_rel(&[".git/packed-refs"]);
        assert_eq!(c, RepoChange { refs: true, ..Default::default() });
        assert!(c.needs_log());
    }

    #[test]
    fn head_sets_head() {
        let c = classify_rel(&[".git/HEAD"]);
        assert_eq!(c, RepoChange { head: true, ..Default::default() });
        assert!(c.needs_log());
    }

    #[test]
    fn objects_and_locks_are_ignored() {
        let c = classify_rel(&[
            ".git/objects/ab/cdef0123456789",
            ".git/logs/HEAD",
            ".git/ORIG_HEAD",
            ".git/index.lock",
            ".git/FETCH_HEAD",
        ]);
        assert!(c.is_empty(), "objects / logs / lock 等不改变可见数据面：{c:?}");
    }

    #[test]
    fn worktree_path_sets_worktree() {
        let c = classify_rel(&["src/main.rs"]);
        assert_eq!(c, RepoChange { worktree: true, ..Default::default() });
        assert!(!c.needs_log());
    }

    #[test]
    fn merge_unions_all_faces() {
        let mut c = classify_rel(&[".git/index"]);
        c.merge(classify_rel(&[".git/refs/tags/v1", ".git/HEAD", "README.md"]));
        assert_eq!(c, RepoChange { index: true, refs: true, head: true, worktree: true });
        assert!(!c.is_empty());
        assert!(c.needs_log());
    }

    #[test]
    fn git_dir_itself_and_empty_input_are_ignored() {
        assert!(classify_rel(&[".git"]).is_empty(), ".git 目录自身不是数据面");
        assert!(classify(&PathBuf::from("repo"), &[]).is_empty());
    }
}
