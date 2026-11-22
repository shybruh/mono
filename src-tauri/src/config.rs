use std::path::PathBuf;

use anyhow::Result;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::audio::Repeat;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub roots: Vec<String>,
    pub volume: f32,
    pub rg_mode: String,
    pub rg_preamp: f32,
    pub repeat: Repeat,
    pub history: bool,
    pub discord: bool,
    pub discord_app_id: String,
    pub deck_skin: String,
    pub deck_meters: Vec<String>,
    pub viz_open: bool,
    pub viz_meters: Vec<String>,
    pub cover_accent: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            roots: Vec::new(),
            volume: 0.8,
            rg_mode: "track".into(),
            rg_preamp: 0.0,
            repeat: Repeat::Off,
            history: true,
            discord: false,
            discord_app_id: String::new(),
            deck_skin: "zinc".into(),
            deck_meters: vec!["spectrum".into(), "peak".into(), "lufs".into(), "cover".into()],
            viz_open: false,
            viz_meters: vec!["spectrum".into(), "scope".into(), "peak".into(), "lufs".into()],
            cover_accent: true,
        }
    }
}

pub struct ConfigStore {
    path: PathBuf,
    cfg: Mutex<Config>,
}

impl ConfigStore {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("config.json");
        let cfg = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { path, cfg: Mutex::new(cfg) }
    }

    pub fn get(&self) -> Config {
        self.cfg.lock().clone()
    }

    /// Shallow-merges `patch` (camelCase keys) into the config and persists it.
    pub fn update(&self, patch: serde_json::Value) -> Result<(Config, Config)> {
        let mut guard = self.cfg.lock();
        let before = guard.clone();
        let mut value = serde_json::to_value(&*guard)?;
        if let (Some(obj), Some(p)) = (value.as_object_mut(), patch.as_object()) {
            for (k, v) in p {
                obj.insert(k.clone(), v.clone());
            }
        }
        let next: Config = serde_json::from_value(value)?;
        *guard = next.clone();
        drop(guard);
        self.save(&next)?;
        Ok((before, next))
    }

    fn save(&self, cfg: &Config) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(cfg)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }
}
