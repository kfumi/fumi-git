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
    /// 界面字体覆盖（预设键，含义见前端 appearance.ts）；None = 默认栈
    pub ui_font: Option<String>,
    /// 等宽字体覆盖（预设键）；None = 默认栈
    pub mono_font: Option<String>,
    /// 字号比例（1.0 = 100%；root 字号 = 16px × 比例，只缩放文字不缩放间距）
    pub font_scale: f32,
    /// 界面缩放因子（webview setZoom；1.0 = 100%）
    pub zoom: f32,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            recent_repos: Vec::new(),
            theme: "system".into(),
            ui_font: None,
            mono_font: None,
            font_scale: 1.0,
            zoom: 1.0,
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
    let now = now_millis();
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

fn now_millis() -> i64 {
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

    #[test]
    fn appearance_fields_roundtrip_and_default() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.json");
        // 旧配置（无外观字段）加载 → 全部默认值
        std::fs::write(&p, r#"{"recent_repos":[],"theme":"dark"}"#).unwrap();
        let legacy = load(&p);
        assert_eq!(legacy.ui_font, None);
        assert_eq!(legacy.mono_font, None);
        assert_eq!(legacy.font_scale, 1.0);
        assert_eq!(legacy.zoom, 1.0);

        let mut cfg = legacy;
        cfg.ui_font = Some("yahei".into());
        cfg.mono_font = Some("cascadia".into());
        cfg.font_scale = 1.15;
        cfg.zoom = 1.2;
        save(&p, &cfg);
        let loaded = load(&p);
        assert_eq!(loaded.ui_font.as_deref(), Some("yahei"));
        assert_eq!(loaded.mono_font.as_deref(), Some("cascadia"));
        assert_eq!(loaded.font_scale, 1.15);
        assert_eq!(loaded.zoom, 1.2);
    }
}
