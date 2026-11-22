//! Visualiser analysis: log-spaced spectrum, scope trace, stereo peak and
//! BS.1770 momentary / short-term loudness. Runs on its own thread and only
//! does work while at least one window has meters enabled.

use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use realfft::RealFftPlanner;
use rtrb::Consumer;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::Shared;

const FFT: usize = 4096;
const BANDS: usize = 96;
const SCOPE: usize = 256;
const FRAME: Duration = Duration::from_micros(16_667);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Meters {
    /// 0..1 per band, 20 Hz – 20 kHz log-spaced.
    pub spectrum: Vec<f32>,
    /// Mono scope trace, -1..1.
    pub scope: Vec<f32>,
    pub peak_l: f32,
    pub peak_r: f32,
    pub lufs_m: f32,
    pub lufs_s: f32,
}

#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn run(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// K-weighting (pre-filter shelf + RLB high-pass) for an arbitrary rate.
fn k_weighting(sr: f64) -> [Biquad; 2] {
    let f0 = 1681.974450955533;
    let g = 3.999843853973347;
    let q = 0.7071752369554196;
    let k = (std::f64::consts::PI * f0 / sr).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad {
        b0: (vh + vb * k / q + k * k) / a0,
        b1: 2.0 * (k * k - vh) / a0,
        b2: (vh - vb * k / q + k * k) / a0,
        a1: 2.0 * (k * k - 1.0) / a0,
        a2: (1.0 - k / q + k * k) / a0,
        ..Default::default()
    };
    let f0 = 38.13547087602444;
    let q = 0.5003270373238773;
    let k = (std::f64::consts::PI * f0 / sr).tan();
    let a0 = 1.0 + k / q + k * k;
    let hp = Biquad {
        b0: 1.0,
        b1: -2.0,
        b2: 1.0,
        a1: 2.0 * (k * k - 1.0) / a0,
        a2: (1.0 - k / q + k * k) / a0,
        ..Default::default()
    };
    [shelf, hp]
}

struct Loudness {
    filters: [[Biquad; 2]; 2],
    /// 100 ms blocks of summed channel mean-square energy.
    blocks: VecDeque<f64>,
    acc: f64,
    acc_n: usize,
    block_len: usize,
}

impl Loudness {
    fn new(sr: u32) -> Self {
        let k = k_weighting(sr as f64);
        Self {
            filters: [k, k],
            blocks: VecDeque::with_capacity(32),
            acc: 0.0,
            acc_n: 0,
            block_len: (sr / 10) as usize,
        }
    }

    fn push(&mut self, l: f32, r: f32) {
        let mut e = 0.0;
        for (ch, x) in [l, r].into_iter().enumerate() {
            let [a, b] = &mut self.filters[ch];
            let y = b.run(a.run(x as f64));
            e += y * y;
        }
        self.acc += e;
        self.acc_n += 1;
        if self.acc_n >= self.block_len {
            self.blocks.push_back(self.acc / self.acc_n as f64);
            if self.blocks.len() > 30 {
                self.blocks.pop_front();
            }
            self.acc = 0.0;
            self.acc_n = 0;
        }
    }

    fn lufs(&self, n: usize) -> f32 {
        let n = n.min(self.blocks.len());
        if n == 0 {
            return -70.0;
        }
        let ms: f64 = self.blocks.iter().rev().take(n).sum::<f64>() / n as f64;
        if ms <= 1e-12 {
            return -70.0;
        }
        (-0.691 + 10.0 * ms.log10()).max(-70.0) as f32
    }
}

pub fn spawn(app: AppHandle, shared: Arc<Shared>, rx: Receiver<(Consumer<f32>, u32)>) {
    std::thread::Builder::new()
        .name("mono-meters".into())
        .spawn(move || run(app, shared, rx))
        .expect("spawn meters thread");
}

fn run(app: AppHandle, shared: Arc<Shared>, rx: Receiver<(Consumer<f32>, u32)>) {
    let Ok((mut cons, mut sr)) = rx.recv() else { return };
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT);
    let mut spectrum_buf = fft.make_output_vec();
    let mut scratch = fft.make_scratch_vec();
    let window: Vec<f32> = (0..FFT)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT - 1) as f32).cos())
        .collect();
    let mut history: VecDeque<f32> = VecDeque::from(vec![0.0; FFT]);
    let mut scope_hist: VecDeque<f32> = VecDeque::from(vec![0.0; SCOPE * 4]);
    let mut fft_in = vec![0.0f32; FFT];
    let mut bands = vec![0.0f32; BANDS];
    let mut loud = Loudness::new(sr);
    let mut peak = [0.0f32; 2];
    // Frames since audio last arrived; once the meters have decayed to the
    // floor the thread stops emitting so an idle window costs nothing.
    let mut quiet_ticks: u32 = 0;
    const QUIET_LIMIT: u32 = 180; // ~3 s of decay at 60 Hz

    loop {
        if let Ok((c, s)) = rx.try_recv() {
            cons = c;
            if s != sr {
                sr = s;
                loud = Loudness::new(sr);
            }
        }
        if !shared.meters_on.load(Ordering::Relaxed) {
            // Drain anything left and idle cheaply.
            let n = cons.slots();
            if n > 0 {
                if let Ok(c) = cons.read_chunk(n) {
                    c.commit_all();
                }
            }
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
        let tick = Instant::now();

        let n = cons.slots() & !1;
        if n > 0 {
            quiet_ticks = 0;
        } else if quiet_ticks >= QUIET_LIMIT {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        } else {
            quiet_ticks += 1;
        }
        let mut blk_peak = [0.0f32; 2];
        if n > 0 {
            if let Ok(c) = cons.read_chunk(n) {
                let (a, b) = c.as_slices();
                for fr in a.chunks_exact(2).chain(b.chunks_exact(2)) {
                    let (l, r) = (fr[0], fr[1]);
                    blk_peak[0] = blk_peak[0].max(l.abs());
                    blk_peak[1] = blk_peak[1].max(r.abs());
                    let m = (l + r) * 0.5;
                    history.pop_front();
                    history.push_back(m);
                    scope_hist.pop_front();
                    scope_hist.push_back(m);
                    loud.push(l, r);
                }
                c.commit_all();
            }
        } else {
            // Feed silence so meters fall naturally while paused.
            let quiet = (sr as usize / 60).max(1);
            for _ in 0..quiet {
                history.pop_front();
                history.push_back(0.0);
                scope_hist.pop_front();
                scope_hist.push_back(0.0);
                loud.push(0.0, 0.0);
            }
        }

        // Peak with ~20 dB/s release.
        let fall = 10f32.powf(-20.0 / 20.0 / 60.0);
        for i in 0..2 {
            peak[i] = blk_peak[i].max(peak[i] * fall);
        }

        // Spectrum.
        for (i, (dst, w)) in fft_in.iter_mut().zip(&window).enumerate() {
            *dst = history[i] * w;
        }
        if fft.process_with_scratch(&mut fft_in, &mut spectrum_buf, &mut scratch).is_ok() {
            let bin_hz = sr as f32 / FFT as f32;
            let norm = 2.0 / (FFT as f32 * 0.5);
            let (lo, hi) = (20f32.ln(), 20_000f32.min(sr as f32 / 2.0).ln());
            for (b, out) in bands.iter_mut().enumerate() {
                let f0 = (lo + (hi - lo) * b as f32 / BANDS as f32).exp();
                let f1 = (lo + (hi - lo) * (b + 1) as f32 / BANDS as f32).exp();
                let i0 = (f0 / bin_hz).floor() as usize;
                let i1 = ((f1 / bin_hz).ceil() as usize).max(i0 + 1).min(spectrum_buf.len() - 1);
                let mut m = 0.0f32;
                for c in &spectrum_buf[i0.min(spectrum_buf.len() - 1)..=i1] {
                    m = m.max(c.norm() * norm);
                }
                // +4.5 dB/oct tilt so pink-ish music reads flat.
                let fc = (f0 * f1).sqrt();
                let db = 20.0 * m.max(1e-9).log10() + 4.5 * (fc / 1000.0).log2();
                let v = ((db + 72.0) / 72.0).clamp(0.0, 1.0);
                *out = if v > *out { v * 0.6 + *out * 0.4 } else { *out * 0.86 + v * 0.14 };
            }
        }

        let step = (scope_hist.len() / SCOPE).max(1);
        let scope: Vec<f32> = scope_hist.iter().step_by(step).take(SCOPE).copied().collect();
        let to_db = |x: f32| if x <= 1e-6 { -96.0 } else { 20.0 * x.log10() };

        let _ = app.emit(
            "meters",
            Meters {
                spectrum: bands.clone(),
                scope,
                peak_l: to_db(peak[0]),
                peak_r: to_db(peak[1]),
                lufs_m: loud.lufs(4),
                lufs_s: loud.lufs(30),
            },
        );

        if let Some(rest) = FRAME.checked_sub(tick.elapsed()) {
            std::thread::sleep(rest);
        }
    }
}
