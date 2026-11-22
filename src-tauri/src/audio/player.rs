//! Decode thread: owns the queue, sources, DSP chain and output stream.
//!
//! Pipeline per chunk:  Source (stereo f32 @ file rate)
//!   -> ReplayGain -> A/B loop wrap -> resample to device rate
//!   -> tempo/pitch stretch -> ring buffer -> cpal callback
//!
//! Gapless: the next queue entry is read into memory and its decoder opened a
//! few seconds before the current one ends. At EOF the pipeline switches
//! source without flushing, so the first sample of the next track lands right
//! after the last sample of the current one.
//!
//! Position: every chunk pushed records a `Mark` (output frame index -> source
//! time). The UI position is derived from frames the device has actually
//! consumed, so it is exact through gapless transitions and stretching.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use rtrb::{Consumer, Producer, RingBuffer};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::output::{self, Output};
use super::resample::Resample;
use super::source::Source;
use super::stretch::Stretch;
use super::{Cmd, Repeat, Shared};
use crate::integrations::Hook;
use crate::meta::{replaygain_linear, TrackMeta};
use crate::AppState;

const PREBUFFER_SECS: f64 = 6.0;
const EMIT_EVERY: Duration = Duration::from_millis(33);

struct Loaded {
    src: Source,
    index: usize,
    gen: u64,
    meta: TrackMeta,
    gain: f32,
}

#[derive(Clone, Copy)]
struct Mark {
    at: u64,
    gen: u64,
    index: usize,
    pos: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub playing: bool,
    pub index: Option<usize>,
    pub queue: Vec<String>,
    pub speed: f64,
    pub semitones: f32,
    pub volume: f32,
    pub loop_a: Option<f64>,
    pub loop_b: Option<f64>,
    pub repeat: Repeat,
    pub rg_mode: String,
    pub rg_preamp: f32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrackEvent {
    pub index: usize,
    pub meta: TrackMeta,
    pub gain_db: f32,
}

#[derive(Serialize, Clone, Copy)]
pub struct PositionEvent {
    pub pos: f64,
    pub duration: f64,
}

pub struct Engine {
    app: AppHandle,
    shared: Arc<Shared>,
    rx: Receiver<Cmd>,
    hooks: Sender<Hook>,
    analysis_tx: Sender<(Consumer<f32>, u32)>,

    output: Option<Output>,
    out_sr: u32,
    written: u64,
    produced: u64,
    pending: Vec<f32>,
    pending_pos: usize,
    marks: VecDeque<Mark>,
    shown: Option<Mark>,
    shown_gen: u64,
    gens: VecDeque<(u64, usize, TrackMeta, f32)>,

    queue: Vec<String>,
    cur: Option<Loaded>,
    next: Option<Loaded>,
    next_failed: Option<usize>,
    gen: u64,
    exhausted: bool,

    resampler: Option<Resample>,
    stretch: Option<Stretch>,
    speed: f64,
    semitones: f32,
    loop_a: Option<f64>,
    loop_b: Option<f64>,
    repeat: Repeat,
    rg_mode: String,
    rg_preamp: f32,
    playing: bool,

    raw: Vec<f32>,
    mid: Vec<f32>,
    last_emit: Instant,
    last_pos: f64,
}

impl Engine {
    pub fn spawn(
        app: AppHandle,
        shared: Arc<Shared>,
        rx: Receiver<Cmd>,
        hooks: Sender<Hook>,
        analysis_tx: Sender<(Consumer<f32>, u32)>,
        rg_mode: String,
        rg_preamp: f32,
    ) {
        std::thread::Builder::new()
            .name("mono-audio".into())
            .spawn(move || {
                let mut e = Engine {
                    app,
                    shared,
                    rx,
                    hooks,
                    analysis_tx,
                    output: None,
                    out_sr: 48_000,
                    written: 0,
                    produced: 0,
                    pending: Vec::new(),
                    pending_pos: 0,
                    marks: VecDeque::new(),
                    shown: None,
                    shown_gen: 0,
                    gens: VecDeque::new(),
                    queue: Vec::new(),
                    cur: None,
                    next: None,
                    next_failed: None,
                    gen: 0,
                    exhausted: false,
                    resampler: None,
                    stretch: None,
                    speed: 1.0,
                    semitones: 0.0,
                    loop_a: None,
                    loop_b: None,
                    repeat: Repeat::Off,
                    rg_mode,
                    rg_preamp,
                    playing: false,
                    raw: Vec::with_capacity(8192),
                    mid: Vec::with_capacity(8192),
                    last_emit: Instant::now(),
                    last_pos: -1.0,
                };
                e.open_output();
                e.run();
            })
            .expect("spawn audio thread");
    }

    fn open_output(&mut self) {
        self.output = None;
        let (aprod, acons) = RingBuffer::<f32>::new(1 << 16);
        match output::open(self.shared.clone(), aprod) {
            Ok(out) => {
                self.out_sr = out.sample_rate;
                let _ = self.analysis_tx.send((acons, out.sample_rate));
                self.output = Some(out);
            }
            Err(e) => eprintln!("output open failed: {e}"),
        }
        self.shared.consumed.store(0, Ordering::Release);
        self.shared.discard_until.store(0, Ordering::Release);
        self.shared.stream_dead.store(false, Ordering::Release);
        self.written = 0;
        self.produced = 0;
        self.pending.clear();
        self.pending_pos = 0;
        self.marks.clear();
        self.resampler = None;
        self.stretch = None;
    }

    fn run(&mut self) {
        loop {
            let busy = self.wants_audio();
            let wait = if busy { Duration::from_millis(2) } else { Duration::from_millis(15) };
            match self.rx.recv_timeout(wait) {
                Ok(cmd) => {
                    if !self.handle(cmd) {
                        return;
                    }
                    while let Ok(cmd) = self.rx.try_recv() {
                        if !self.handle(cmd) {
                            return;
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }

            if self.shared.stream_dead.load(Ordering::Acquire) {
                let pos = self.display_pos();
                drop(self.output.take());
                std::thread::sleep(Duration::from_millis(250));
                self.open_output();
                if self.cur.is_some() {
                    self.seek(pos);
                }
            }

            for _ in 0..16 {
                if !self.produce() {
                    break;
                }
            }
            self.maybe_prepare_next();
            self.check_drained();
            self.emit_progress(false);
        }
    }

    fn wants_audio(&self) -> bool {
        self.cur.is_some() && self.output.as_ref().map(|o| o.producer.slots() > 2048).unwrap_or(false)
    }

    // ---------------------------------------------------------------- commands

    fn handle(&mut self, cmd: Cmd) -> bool {
        match cmd {
            Cmd::PlayQueue { paths, index } => {
                self.queue = paths;
                self.next = None;
                self.load_index(index, true);
            }
            Cmd::SetQueue { paths, index } => {
                // Replace the queue without interrupting the current track.
                self.queue = paths;
                self.next = None;
                self.next_failed = None;
                if let Some(cur) = &mut self.cur {
                    cur.index = index;
                }
                if let Some(m) = &mut self.shown {
                    m.index = index;
                }
                for m in self.marks.iter_mut() {
                    m.index = index;
                }
                self.emit_state();
            }
            Cmd::PlayIndex(i) => self.load_index(i, true),
            Cmd::Play => self.set_playing(true),
            Cmd::Pause => self.set_playing(false),
            Cmd::Toggle => self.set_playing(!self.playing),
            Cmd::Next => {
                if let Some(i) = self.following(self.display_index().unwrap_or(0), true) {
                    self.load_index(i, self.playing);
                }
            }
            Cmd::Prev => {
                let idx = self.display_index().unwrap_or(0);
                if self.display_pos() > 3.0 || idx == 0 {
                    self.seek(0.0);
                } else {
                    self.load_index(idx - 1, self.playing);
                }
            }
            Cmd::Seek(t) => self.seek(t),
            Cmd::SeekRelative(dt) => {
                let p = self.display_pos();
                self.seek((p + dt).max(0.0));
            }
            Cmd::SetLoop { a, b } => {
                self.loop_a = a;
                self.loop_b = b;
                self.emit_state();
            }
            Cmd::SetSpeed(s) => {
                self.speed = s.clamp(0.25, 4.0);
                self.emit_state();
            }
            Cmd::SetPitch(st) => {
                self.semitones = st.clamp(-24.0, 24.0);
                self.emit_state();
            }
            Cmd::SetVolume(v) => {
                let v = v.clamp(0.0, 1.5);
                self.shared.volume.store(v.to_bits(), Ordering::Relaxed);
                self.emit_state();
            }
            Cmd::SetReplayGain { mode, preamp } => {
                self.rg_mode = mode;
                self.rg_preamp = preamp;
                for l in [self.cur.as_mut(), self.next.as_mut()].into_iter().flatten() {
                    l.gain = replaygain_linear(&l.meta, &self.rg_mode, self.rg_preamp);
                }
                self.emit_state();
            }
            Cmd::SetRepeat(r) => {
                self.repeat = r;
                self.next = None;
                self.next_failed = None;
                self.emit_state();
            }
            Cmd::RefreshMeta(path) => {
                // Tags were edited: refresh the cached meta of matching loads.
                let state = self.app.state::<AppState>();
                for l in [self.cur.as_mut(), self.next.as_mut()].into_iter().flatten() {
                    if l.meta.path == path {
                        l.meta = state.meta.get(std::path::Path::new(&path));
                    }
                }
                if let Some(cur) = &self.cur {
                    if cur.meta.path == path && self.shown_gen == cur.gen {
                        self.emit_track(cur.index, cur.meta.clone(), cur.gain);
                    }
                }
            }
            Cmd::EmitState => {
                self.emit_state();
                if let Some(entry) = self.gens.iter().find(|g| g.0 == self.shown_gen).cloned() {
                    self.emit_track(entry.1, entry.2, entry.3);
                }
                self.emit_progress(true);
            }
            Cmd::Shutdown => return false,
        }
        true
    }

    fn set_playing(&mut self, on: bool) {
        if on && self.cur.is_none() && !self.queue.is_empty() {
            self.load_index(self.display_index().unwrap_or(0), true);
            return;
        }
        self.playing = on && self.cur.is_some();
        self.shared.paused.store(!self.playing, Ordering::Release);
        self.emit_state();
        let _ = self.hooks.send(Hook::Playing { playing: self.playing, pos: self.display_pos() });
    }

    fn following(&self, from: usize, manual: bool) -> Option<usize> {
        if self.queue.is_empty() {
            return None;
        }
        if self.repeat == Repeat::One && !manual {
            return Some(from);
        }
        if from + 1 < self.queue.len() {
            Some(from + 1)
        } else if self.repeat != Repeat::Off {
            Some(0)
        } else {
            None
        }
    }

    fn open_loaded(&mut self, index: usize) -> Option<Loaded> {
        let path = PathBuf::from(self.queue.get(index)?);
        let src = match Source::open(&path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("open {}: {e}", path.display());
                return None;
            }
        };
        let state = self.app.state::<AppState>();
        let mut meta = state.meta.get(&path);
        if meta.duration <= 0.0 {
            meta.duration = src.duration;
        }
        let gain = replaygain_linear(&meta, &self.rg_mode, self.rg_preamp);
        self.gen += 1;
        Some(Loaded { src, index, gen: self.gen, meta, gain })
    }

    fn flush(&mut self) {
        self.pending.clear();
        self.pending_pos = 0;
        self.produced = self.written;
        self.shared.discard_until.store(self.written, Ordering::Release);
        self.marks.clear();
        if let Some(r) = &mut self.resampler {
            r.reset();
        }
        if let Some(s) = &mut self.stretch {
            s.reset();
        }
    }

    fn load_index(&mut self, index: usize, play: bool) {
        self.flush();
        self.next = None;
        self.next_failed = None;
        self.exhausted = false;
        let mut idx = index;
        let mut tries = 0;
        let loaded = loop {
            if idx >= self.queue.len() || tries >= self.queue.len() {
                break None;
            }
            if let Some(l) = self.open_loaded(idx) {
                break Some(l);
            }
            tries += 1;
            idx += 1;
        };
        self.cur = loaded;
        let Some(cur) = &self.cur else {
            self.playing = false;
            self.shared.paused.store(true, Ordering::Release);
            self.emit_state();
            return;
        };
        let mark = Mark { at: self.produced, gen: cur.gen, index: cur.index, pos: 0.0 };
        self.remember(cur.gen, cur.index, cur.meta.clone(), cur.gain);
        self.marks.push_back(mark);
        self.playing = play;
        self.shared.paused.store(!play, Ordering::Release);
        self.emit_state();
    }

    fn seek(&mut self, t: f64) {
        // If the device is still playing the previous track (gapless overlap),
        // seek within that one rather than the already-switched source.
        if let (Some(shown), Some(cur)) = (self.shown, &self.cur) {
            if shown.gen != cur.gen {
                let play = self.playing;
                self.load_index(shown.index, play);
            }
        }
        let Some(cur) = &mut self.cur else { return };
        let t = t.clamp(0.0, cur.meta.duration.max(cur.src.duration));
        if let Err(e) = cur.src.seek(t) {
            eprintln!("{e}");
            return;
        }
        let (gen, index, pos) = (cur.gen, cur.index, cur.src.position());
        self.flush();
        self.exhausted = false;
        self.marks.push_back(Mark { at: self.produced, gen, index, pos });
        self.shown = Some(Mark { at: self.shared.consumed.load(Ordering::Acquire).max(self.produced), gen, index, pos });
        self.emit_progress(true);
        let _ = self.hooks.send(Hook::Playing { playing: self.playing, pos });
    }

    // ---------------------------------------------------------------- production

    fn produce(&mut self) -> bool {
        let Some(out) = &mut self.output else { return false };

        if self.pending_pos < self.pending.len() {
            let remaining = self.pending.len() - self.pending_pos;
            let n = remaining.min(out.producer.slots()) & !1;
            if n == 0 {
                return false;
            }
            write_all(&mut out.producer, &self.pending[self.pending_pos..self.pending_pos + n]);
            self.pending_pos += n;
            self.written += (n / 2) as u64;
            if self.pending_pos >= self.pending.len() {
                self.pending.clear();
                self.pending_pos = 0;
            }
            return true;
        }
        if out.producer.slots() < 4096 || self.cur.is_none() || self.exhausted {
            return false;
        }

        self.raw.clear();
        let cur = self.cur.as_mut().unwrap();
        let ok = cur.src.next_chunk(&mut self.raw).unwrap_or_else(|e| {
            eprintln!("{e}");
            false
        });

        if !ok {
            if let Some(next) = self.next.take() {
                self.remember(next.gen, next.index, next.meta.clone(), next.gain);
                self.cur = Some(next);
                self.next_failed = None;
                return true;
            }
            self.exhausted = true;
            return false;
        }

        let sr = cur.src.sample_rate;
        let mut pos = cur.src.position();
        if let (Some(a), Some(b)) = (self.loop_a, self.loop_b) {
            if b > a + 0.01 && pos >= b {
                let over = ((pos - b) * sr as f64) as usize;
                let frames = self.raw.len() / 2;
                self.raw.truncate(frames.saturating_sub(over) * 2);
                let _ = cur.src.seek(a);
                pos = b;
            }
        }
        if (cur.gain - 1.0).abs() > 1e-4 {
            for s in self.raw.iter_mut() {
                *s *= cur.gain;
            }
        }
        let (gen, index) = (cur.gen, cur.index);

        // Resample to device rate.
        let resampled: &[f32] = if sr != self.out_sr {
            if self.resampler.as_ref().map(|r| r.from != sr).unwrap_or(true) {
                self.resampler = Resample::new(sr, self.out_sr);
            }
            self.mid.clear();
            match &mut self.resampler {
                Some(r) => r.push(&self.raw, &mut self.mid),
                None => self.mid.extend_from_slice(&self.raw),
            }
            &self.mid
        } else {
            &self.raw
        };

        // Tempo / pitch.
        let start = self.pending.len();
        let active = (self.speed - 1.0).abs() > 1e-3 || self.semitones.abs() > 1e-3;
        if active {
            let st = self.stretch.get_or_insert_with(|| Stretch::new(2, self.out_sr));
            st.set_semitones(self.semitones);
            st.process(resampled, self.speed, &mut self.pending);
        } else {
            self.stretch = None;
            self.pending.extend_from_slice(resampled);
        }
        let frames = (self.pending.len() - start) / 2;
        self.produced += frames as u64;
        self.marks.push_back(Mark { at: self.produced, gen, index, pos });
        true
    }

    fn maybe_prepare_next(&mut self) {
        if self.next.is_some() || self.exhausted {
            return;
        }
        let Some(cur) = &self.cur else { return };
        let dur = cur.meta.duration.max(cur.src.duration);
        let near_end = dur <= 0.0 || dur - cur.src.position() < PREBUFFER_SECS;
        if !near_end {
            return;
        }
        let Some(mut idx) = self.following(cur.index, false) else { return };
        if self.next_failed == Some(idx) {
            return;
        }
        let first = idx;
        loop {
            if let Some(l) = self.open_loaded(idx) {
                self.next = Some(l);
                return;
            }
            match self.following(idx, true) {
                Some(n) if n != first => idx = n,
                _ => {
                    self.next_failed = Some(first);
                    return;
                }
            }
        }
    }

    fn check_drained(&mut self) {
        if !self.exhausted || self.pending_pos < self.pending.len() {
            return;
        }
        let consumed = self.shared.consumed.load(Ordering::Acquire);
        if consumed >= self.written && self.playing {
            // End of queue: park on the last track, stopped at 0.
            let idx = self.cur.as_ref().map(|c| c.index).unwrap_or(0);
            self.emit_progress(true);
            self.load_index(idx, false);
            self.exhausted = false;
            let _ = self.hooks.send(Hook::Playing { playing: false, pos: 0.0 });
        }
    }

    // ---------------------------------------------------------------- reporting

    fn remember(&mut self, gen: u64, index: usize, meta: TrackMeta, gain: f32) {
        self.gens.push_back((gen, index, meta, gain));
        while self.gens.len() > 4 {
            self.gens.pop_front();
        }
    }

    fn advance_shown(&mut self) {
        let consumed = self.shared.consumed.load(Ordering::Acquire);
        while let Some(m) = self.marks.front() {
            if m.at <= consumed {
                self.shown = self.marks.pop_front();
            } else {
                break;
            }
        }
        if self.shown.is_none() {
            self.shown = self.marks.front().copied();
        }
    }

    fn display_index(&self) -> Option<usize> {
        self.shown.map(|m| m.index).or(self.cur.as_ref().map(|c| c.index))
    }

    fn display_pos(&self) -> f64 {
        let Some(m) = self.shown else { return 0.0 };
        let consumed = self.shared.consumed.load(Ordering::Acquire);
        let extra = consumed.saturating_sub(m.at) as f64 * self.speed / self.out_sr as f64;
        let mut p = m.pos + extra;
        if let Some(n) = self.marks.front() {
            if n.gen == m.gen {
                p = p.min(n.pos);
            }
        }
        p.max(0.0)
    }

    fn emit_progress(&mut self, force: bool) {
        if !force && self.last_emit.elapsed() < EMIT_EVERY {
            return;
        }
        self.last_emit = Instant::now();
        self.advance_shown();
        let Some(m) = self.shown else { return };
        if m.gen != self.shown_gen {
            self.shown_gen = m.gen;
            if let Some(entry) = self.gens.iter().find(|g| g.0 == m.gen).cloned() {
                self.emit_track(entry.1, entry.2.clone(), entry.3);
                let _ = self.hooks.send(Hook::Track { meta: entry.2, playing: self.playing });
            }
            self.emit_state();
        }
        let pos = self.display_pos();
        if force || (pos - self.last_pos).abs() > 0.001 {
            self.last_pos = pos;
            let duration = self
                .gens
                .iter()
                .find(|g| g.0 == m.gen)
                .map(|g| g.2.duration)
                .unwrap_or(0.0);
            let _ = self.app.emit("position", PositionEvent { pos, duration });
        }
    }

    fn emit_track(&self, index: usize, meta: TrackMeta, gain: f32) {
        let _ = self.app.emit("track", TrackEvent { index, meta, gain_db: 20.0 * gain.max(1e-6).log10() });
    }

    fn emit_state(&self) {
        let _ = self.app.emit(
            "player-state",
            PlayerState {
                playing: self.playing,
                index: self.display_index(),
                queue: self.queue.clone(),
                speed: self.speed,
                semitones: self.semitones,
                volume: f32::from_bits(self.shared.volume.load(Ordering::Relaxed)),
                loop_a: self.loop_a,
                loop_b: self.loop_b,
                repeat: self.repeat,
                rg_mode: self.rg_mode.clone(),
                rg_preamp: self.rg_preamp,
            },
        );
    }
}

fn write_all(prod: &mut Producer<f32>, data: &[f32]) {
    if let Ok(chunk) = prod.write_chunk_uninit(data.len()) {
        chunk.fill_from_iter(data.iter().copied());
    }
}
