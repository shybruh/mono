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
    /// Cover-art URL for the Discord status, found by the UI (iTunes).
    Art { path: String, url: Option<String> },
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

/// Asset key of the logo uploaded to the Discord application.
const LOGO: &str = "mono";
/// Discord accepts at most 5 activity updates per 20 s; keep well inside it.
const MIN_GAP: Duration = Duration::from_secs(4);
const RETRY: Duration = Duration::from_secs(5);

/// What the Discord status should show right now.
#[derive(Clone, Default)]
struct Desired {
    meta: Option<TrackMeta>,
    playing: bool,
    /// Unix time the track would have started at (now - position).
    start: i64,
    art: Option<String>,
}

impl Desired {
    /// Changes only when something visible changes (start rounded so normal
    /// clock drift doesn't count, seeks do).
    fn signature(&self) -> String {
        match (&self.meta, self.playing) {
            (Some(m), true) => format!(
                "{}|{}|{}|{}",
                m.path,
                m.title,
                self.start / 3,
                self.art.as_deref().unwrap_or("")
            ),
            _ => "idle".into(),
        }
    }
}

/// Discord rejects strings shorter than 2 or longer than 128 characters.
fn fit(s: &str) -> String {
    let s = s.trim();
    let mut out: String = if s.chars().count() > 128 {
        s.chars().take(127).collect::<String>() + "\u{2026}"
    } else {
        s.to_owned()
    };
    while out.chars().count() < 2 {
        out.push('\u{2007}');
    }
    out
}

/// Keeps Discord showing `Desired`: connects lazily, reads every reply
/// (unread replies back up the pipe and stall Discord), rate-limits, and
/// re-sends the current state after any failure or reconnect.
struct Discord {
    app_id: String,
    client: Option<DiscordIpcClient>,
    sent: Option<String>,
    last_send: Option<Instant>,
    retry_at: Option<Instant>,
}

impl Discord {
    fn new(app_id: String) -> Self {
        Self { app_id, client: None, sent: None, last_send: None, retry_at: None }
    }

    fn drop_client(&mut self) {
        if let Some(mut c) = self.client.take() {
            let _ = c.close();
        }
        self.sent = None;
    }

    fn shutdown(&mut self) {
        if let Some(mut c) = self.client.take() {
            if c.clear_activity().is_ok() {
                let _ = c.recv();
            }
            let _ = c.close();
        }
        self.sent = None;
        self.retry_at = None;
    }

    /// Next moment `sync` has work to do, if any.
    fn deadline(&self, want: &str) -> Option<Instant> {
        if self.sent.as_deref() == Some(want) {
            return None;
        }
        let gap = self.last_send.map(|t| t + MIN_GAP);
        match (gap, self.retry_at) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => Some(a.or(b).unwrap_or_else(Instant::now)),
        }
    }

    fn sync(&mut self, d: &Desired) {
        if self.app_id.is_empty() {
            return;
        }
        let want = d.signature();
        if self.sent.as_deref() == Some(want.as_str()) {
            return;
        }
        let now = Instant::now();
        if self.retry_at.map(|t| now < t).unwrap_or(false) {
            return;
        }
        if self.last_send.map(|t| now < t + MIN_GAP).unwrap_or(false) {
            return;
        }
        if self.client.is_none() {
            let mut c = DiscordIpcClient::new(&self.app_id);
            if c.connect().is_err() {
                self.retry_at = Some(now + RETRY);
                return;
            }
            self.client = Some(c);
        }
        let client = self.client.as_mut().unwrap();
        let result = match (&d.meta, d.playing) {
            (Some(m), true) => {
                let mut ts = Timestamps::new().start(d.start);
                if m.duration > 0.0 {
                    ts = ts.end(d.start + m.duration.round() as i64);
                }
                let album = m.album.clone().filter(|a| !a.trim().is_empty());
                // Spotify-style: album art large with the logo as a badge;
                // without art, the logo alone.
                let assets = match &d.art {
                    Some(url) => {
                        let mut a = Assets::new().large_image(url.as_str()).small_image(LOGO).small_text("mono");
                        if let Some(al) = &album {
                            a = a.large_text(fit(al));
                        }
                        a
                    }
                    None => Assets::new().large_image(LOGO).large_text(fit(album.as_deref().unwrap_or("mono"))),
                };
                let mut act = Activity::new()
                    .activity_type(ActivityType::Listening)
                    .details(fit(&m.title))
                    .timestamps(ts)
                    .assets(assets);
                if let Some(artist) = m.artist.as_deref().filter(|a| !a.trim().is_empty()) {
                    act = act.state(fit(artist));
                }
                client.set_activity(act)
            }
            _ => client.clear_activity(),
        };
        // Always consume Discord's reply.
        let ok = result.is_ok()
            && match client.recv() {
                Ok((_, reply)) => reply.get("evt").and_then(|e| e.as_str()) != Some("ERROR"),
                Err(_) => false,
            };
        self.last_send = Some(now);
        if ok {
            self.sent = Some(want);
            self.retry_at = None;
        } else {
            // Rate-limited, rejected or the pipe broke: reconnect and resend.
            self.drop_client();
            self.retry_at = Some(now + RETRY);
        }
    }
}

pub fn spawn(
    data_dir: PathBuf,
    rx: Receiver<Hook>,
    history: bool,
    discord: bool,
    app_id: String,
    media: Option<crate::media::Media>,
) {
    std::thread::Builder::new()
        .name("mono-integrations".into())
        .spawn(move || {
            let mut history_on = history;
            let mut discord_on = discord;
            let mut dc = Discord::new(effective_app_id(&app_id));
            let mut want = Desired::default();
            loop {
                let wait = if discord_on {
                    dc.deadline(&want.signature())
                        .map(|t| t.saturating_duration_since(Instant::now()))
                        .unwrap_or(Duration::from_secs(30))
                } else {
                    Duration::from_secs(60)
                };
                match rx.recv_timeout(wait) {
                    Ok(Hook::Track { meta, playing }) => {
                        if history_on {
                            append_history(&data_dir, &meta);
                        }
                        if let Some(m) = &media {
                            m.track(&meta, playing);
                        }
                        want = Desired { meta: Some(meta), playing, start: now_secs() as i64, art: None };
                    }
                    Ok(Hook::Playing { playing, pos }) => {
                        if let Some(m) = &media {
                            m.playing(playing, pos);
                        }
                        want.playing = playing;
                        want.start = now_secs() as i64 - pos.round() as i64;
                    }
                    Ok(Hook::Art { path, url }) => {
                        if want.meta.as_ref().map(|m| m.path == path).unwrap_or(false) {
                            want.art = url.filter(|u| u.starts_with("https://") && u.len() <= 256);
                        }
                    }
                    Ok(Hook::Config { history, discord, app_id }) => {
                        history_on = history;
                        let app_id = effective_app_id(&app_id);
                        if !discord || app_id != dc.app_id {
                            dc.shutdown();
                        }
                        dc.app_id = app_id;
                        discord_on = discord;
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        dc.shutdown();
                        return;
                    }
                }
                if discord_on {
                    dc.sync(&want);
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
