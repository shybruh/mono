//! "Resume where you left off": the last session (queue, track, position)
//! and per-track positions for long files such as mixes and audiobooks.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Tracks at least this long remember their own position.
pub const LONG_TRACK: f64 = 15.0 * 60.0;
/// Positions this close to either end count as "not started" / "finished".
const EDGE: f64 = 30.0;
const MAX_ENTRIES: usize = 500;

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Session {
    pub queue: Vec<String>,
    pub index: usize,
    pub pos: f64,
}

fn write_atomic(path: &Path, bytes: &[u8]) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, bytes).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

pub fn load_session(dir: &Path) -> Option<Session> {
    let s: Session = serde_json::from_slice(&std::fs::read(dir.join("session.json")).ok()?).ok()?;
    // Drop files that have gone missing, keeping the current track aligned.
    let current = s.queue.get(s.index).cloned();
    let queue: Vec<String> = s.queue.into_iter().filter(|p| Path::new(p).is_file()).collect();
    let index = current.and_then(|c| queue.iter().position(|p| *p == c))?;
    Some(Session { queue, index, pos: s.pos })
}

pub fn save_session(dir: &Path, s: &Session) {
    if let Ok(bytes) = serde_json::to_vec(s) {
        write_atomic(&dir.join("session.json"), &bytes);
    }
}

pub struct Positions {
    file: PathBuf,
    map: HashMap<String, f64>,
    dirty: bool,
}

impl Positions {
    pub fn load(dir: &Path) -> Self {
        let file = dir.join("positions.json");
        let map = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self { file, map, dirty: false }
    }

    pub fn get(&self, path: &str) -> Option<f64> {
        self.map.get(path).copied()
    }

    /// Records where a long track was left; forgets it once finished.
    pub fn note(&mut self, path: &str, duration: f64, pos: f64) {
        if duration < LONG_TRACK {
            return;
        }
        if pos > EDGE && pos < duration - EDGE {
            if self.map.get(path).map(|p| (p - pos).abs() > 1.0).unwrap_or(true) {
                self.map.insert(path.to_owned(), pos);
                self.dirty = true;
            }
        } else if self.map.remove(path).is_some() {
            self.dirty = true;
        }
    }

    pub fn save(&mut self) {
        if !self.dirty {
            return;
        }
        if self.map.len() > MAX_ENTRIES {
            // Arbitrary eviction is fine: it only loses a resume point.
            let extra: Vec<String> = self.map.keys().take(self.map.len() - MAX_ENTRIES).cloned().collect();
            for k in extra {
                self.map.remove(&k);
            }
        }
        if let Ok(bytes) = serde_json::to_vec(&self.map) {
            write_atomic(&self.file, &bytes);
            self.dirty = false;
        }
    }
}
