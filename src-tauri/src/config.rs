//! 应用配置（最近仓库、主题）的 JSON 持久化，存于系统应用配置目录。

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoEntry {
    pub path: String,
    pub name: String,
    pub last_opened: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub recent_repos: Vec<RepoEntry>,
    /// dark | light | system
    pub theme: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            recent_repos: Vec::new(),
            theme: "system".into(),
        }
    }
}

pub fn load(path: &Path) -> AppConfig {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, cfg: &AppConfig) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_vec_pretty(cfg) {
        let _ = std::fs::write(path, json);
    }
}

/// 把 path 移到最近列表首位（去重，容量 10）。
pub fn touch_recent(cfg: &mut AppConfig, path: &str, name: &str) {
    let now = chrono_millis();
    cfg.recent_repos.retain(|e| e.path != path);
    cfg.recent_repos.insert(
        0,
        RepoEntry {
            path: path.to_string(),
            name: name.to_string(),
            last_opened: now,
        },
    );
    cfg.recent_repos.truncate(10);
}

fn chrono_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_touch_recent() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.json");
        let mut cfg = AppConfig::default();
        touch_recent(&mut cfg, "D:/repos/demo", "demo");
        touch_recent(&mut cfg, "D:/repos/other", "other");
        touch_recent(&mut cfg, "D:/repos/demo", "demo");
        assert_eq!(cfg.recent_repos[0].path, "D:/repos/demo");
        assert_eq!(cfg.recent_repos.len(), 2);
        save(&p, &cfg);
        let loaded = load(&p);
        assert_eq!(loaded.theme, "system");
        assert_eq!(loaded.recent_repos.len(), 2);
        assert_eq!(loaded.recent_repos[1].name, "other");
    }
}
