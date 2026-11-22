//! Optional modules: listening history (JSON lines) and Discord Rich Presence.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crossbeam_channel::{Receiver, RecvTimeoutError};
use discord_rich_presence::activity::{Activity, ActivityType, Assets, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::{Deserialize, Serialize};

use crate::meta::TrackMeta;

pub enum Hook {
    Track { meta: TrackMeta, playing: bool },
    Playing { playing: bool, pos: f64 },
    Config { history: bool, discord: bool, app_id: String },
}

#[derive(Serialize, Deserialize, Clone)]
pub struct HistoryEntry {
    pub path: String,
    pub title: String,
    pub artist: Option<String>,
    pub at: u64,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn history_path(data_dir: &Path) -> PathBuf {
    data_dir.join("history.jsonl")
}

/// Unique paths played within `days`, newest first.
pub fn read_history(data_dir: &Path, days: u64) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(history_path(data_dir)) else { return Vec::new() };
    let cutoff = now_secs().saturating_sub(days * 86_400);
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for line in text.lines().rev() {
        let Ok(e) = serde_json::from_str::<HistoryEntry>(line) else { continue };
        if e.at < cutoff {
            break;
        }
        if seen.insert(e.path.clone()) && Path::new(&e.path).is_file() {
            out.push(e.path);
        }
    }
    out
}

/// Mono's own Discord application ("Listening to mono"). This is a public
/// client ID, not a secret. Users can override it in Settings.
pub const BUILTIN_DISCORD_APP_ID: &str = "1574048757648072765";

fn effective_app_id(configured: &str) -> String {
    let c = configured.trim();
    if c.is_empty() { BUILTIN_DISCORD_APP_ID.to_owned() } else { c.to_owned() }
}

struct Discord {
    app_id: String,
    client: Option<DiscordIpcClient>,
    last_attempt: Option<Instant>,
}

impl Discord {
    fn connected(&mut self) -> Option<&mut DiscordIpcClient> {
        if self.client.is_none() {
            if self.app_id.is_empty() {
                return None;
            }
            if self.last_attempt.map(|t| t.elapsed() < Duration::from_secs(15)).unwrap_or(false) {
                return None;
            }
            self.last_attempt = Some(Instant::now());
            let mut c = DiscordIpcClient::new(&self.app_id);
            if c.connect().is_ok() {
                self.client = Some(c);
            }
        }
        self.client.as_mut()
    }

    fn update(&mut self, meta: Option<&TrackMeta>, playing: bool, pos: f64) {
        let ok = {
            let Some(client) = self.connected() else { return };
            match (meta, playing) {
                (Some(m), true) => {
                    let start = now_secs() as i64 - pos as i64;
                    let mut ts = Timestamps::new().start(start);
                    if m.duration > 0.0 {
                        ts = ts.end(start + m.duration as i64);
                    }
                    let details = m.title.clone();
                    let state = m.artist.clone().unwrap_or_default();
                    let album = m.album.clone().unwrap_or_default();
                    let mut act = Activity::new()
                        .activity_type(ActivityType::Listening)
                        .details(details)
                        .timestamps(ts)
                        // "mono" is the art asset key uploaded to the Discord app.
                        .assets(Assets::new().large_image("mono").large_text(album));
                    if !state.is_empty() {
                        act = act.state(state);
                    }
                    client.set_activity(act).is_ok()
                }
                _ => client.clear_activity().is_ok(),
            }
        };
        if !ok {
            if let Some(mut c) = self.client.take() {
                let _ = c.close();
            }
        }
    }

    fn shutdown(&mut self) {
        if let Some(mut c) = self.client.take() {
            let _ = c.clear_activity();
            let _ = c.close();
        }
    }
}

pub fn spawn(data_dir: PathBuf, rx: Receiver<Hook>, history: bool, discord: bool, app_id: String) {
    std::thread::Builder::new()
        .name("mono-integrations".into())
        .spawn(move || {
            let mut history_on = history;
            let mut discord_on = discord;
            let mut dc = Discord { app_id: effective_app_id(&app_id), client: None, last_attempt: None };
            let mut current: Option<TrackMeta> = None;
            let mut playing = false;
            let mut pos = 0.0;
            loop {
                match rx.recv_timeout(Duration::from_secs(20)) {
                    Ok(Hook::Track { meta, playing: p }) => {
                        if history_on {
                            append_history(&data_dir, &meta);
                        }
                        playing = p;
                        pos = 0.0;
                        current = Some(meta);
                    }
                    Ok(Hook::Playing { playing: p, pos: t }) => {
                        playing = p;
                        pos = t;
                    }
                    Ok(Hook::Config { history, discord, app_id }) => {
                        let app_id = effective_app_id(&app_id);
                        history_on = history;
                        if !discord || app_id != dc.app_id {
                            dc.shutdown();
                        }
                        dc.app_id = app_id;
                        dc.last_attempt = None;
                        discord_on = discord;
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        // Periodic retry if Discord was not running earlier.
                        if !discord_on || dc.client.is_some() {
                            continue;
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        dc.shutdown();
                        return;
                    }
                }
                if discord_on {
                    dc.update(current.as_ref(), playing, pos);
                }
            }
        })
        .ok();
}

fn append_history(data_dir: &Path, meta: &TrackMeta) {
    let entry = HistoryEntry {
        path: meta.path.clone(),
        title: meta.title.clone(),
        artist: meta.artist.clone(),
        at: now_secs(),
    };
    let _ = std::fs::create_dir_all(data_dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(history_path(data_dir)) {
        if let Ok(line) = serde_json::to_string(&entry) {
            let _ = writeln!(f, "{line}");
        }
    }
}
