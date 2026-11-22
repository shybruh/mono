pub mod meters;
pub mod output;
pub mod player;
pub mod resample;
pub mod source;
pub mod stretch;
pub mod waveform;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use crossbeam_channel::Sender;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    Off,
    All,
    One,
}

pub enum Cmd {
    PlayQueue { paths: Vec<String>, index: usize },
    SetQueue { paths: Vec<String>, index: usize },
    PlayIndex(usize),
    Play,
    Pause,
    Toggle,
    Next,
    Prev,
    Seek(f64),
    SeekRelative(f64),
    SetLoop { a: Option<f64>, b: Option<f64> },
    SetSpeed(f64),
    SetPitch(f32),
    SetVolume(f32),
    SetReplayGain { mode: String, preamp: f32 },
    SetRepeat(Repeat),
    RefreshMeta(String),
    EmitState,
    #[allow(dead_code)]
    Shutdown,
}

/// State shared lock-free between the decode thread and the device callback.
pub struct Shared {
    pub volume: AtomicU32,
    pub paused: AtomicBool,
    pub consumed: AtomicU64,
    pub discard_until: AtomicU64,
    pub meters_on: AtomicBool,
    pub stream_dead: AtomicBool,
}

impl Shared {
    pub fn new(volume: f32) -> Self {
        Self {
            volume: AtomicU32::new(volume.to_bits()),
            paused: AtomicBool::new(true),
            consumed: AtomicU64::new(0),
            discard_until: AtomicU64::new(0),
            meters_on: AtomicBool::new(false),
            stream_dead: AtomicBool::new(false),
        }
    }
}

pub struct Player {
    pub tx: Sender<Cmd>,
    pub shared: Arc<Shared>,
    /// Per window: (latest request sequence, wants meters).
    meter_windows: Mutex<HashMap<String, (u64, bool)>>,
}

impl Player {
    pub fn new(tx: Sender<Cmd>, shared: Arc<Shared>) -> Self {
        Self { tx, shared, meter_windows: Mutex::new(HashMap::new()) }
    }

    pub fn send(&self, cmd: Cmd) {
        let _ = self.tx.send(cmd);
    }

    /// Meters run while any window asks for them. Requests older than the
    /// last one seen from that window are ignored, so IPC reordering can't
    /// leave meters stuck off (or on).
    pub fn set_meters(&self, window: &str, on: bool, seq: u64) {
        let mut map = self.meter_windows.lock();
        match map.get(window) {
            Some((last, _)) if *last >= seq => return,
            _ => {
                map.insert(window.to_owned(), (seq, on));
            }
        }
        self.refresh(&map);
    }

    /// Forget a window entirely (closed or destroyed).
    pub fn drop_window(&self, window: &str) {
        let mut map = self.meter_windows.lock();
        map.remove(window);
        self.refresh(&map);
    }

    fn refresh(&self, map: &HashMap<String, (u64, bool)>) {
        let any = map.values().any(|(_, on)| *on);
        self.shared.meters_on.store(any, Ordering::Relaxed);
    }
}
