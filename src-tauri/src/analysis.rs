//! Tempo (BPM) and musical key detection.
//!
//! Both work on a mono, ~11 kHz copy of the track:
//! - Tempo: spectral-flux onset envelope -> autocorrelation weighted toward
//!   typical tempos -> fine search at 0.05 BPM steps, folded into 78-180.
//! - Key: chroma (energy per pitch class, 55 Hz-2 kHz) correlated against
//!   Krumhansl-Kessler major / minor profiles for all 24 keys.

use std::path::Path;

use anyhow::{anyhow, Result};
use realfft::RealFftPlanner;
use serde::Serialize;

use crate::audio::source::Source;

const TARGET_SR: f32 = 11_025.0;
/// Analyse at most this much audio (long mixes would take a while).
const MAX_SECONDS: f32 = 600.0;

#[derive(Serialize, Clone, Debug)]
pub struct Analysis {
    pub bpm: Option<f32>,
    /// Standard notation, e.g. "Am", "F#", "Eb".
    pub key: Option<String>,
}

/// Decodes to mono at roughly TARGET_SR by block averaging.
fn mono_downsampled(path: &Path) -> Result<(Vec<f32>, f32)> {
    let mut src = Source::open(path)?;
    let factor = (src.sample_rate as f32 / TARGET_SR).round().max(1.0) as usize;
    let sr = src.sample_rate as f32 / factor as f32;
    let limit = (MAX_SECONDS * sr) as usize;
    let mut out = Vec::with_capacity(limit.min(1 << 22));
    let mut chunk = Vec::with_capacity(8192);
    let (mut acc, mut n) = (0.0f32, 0usize);
    while out.len() < limit {
        chunk.clear();
        if !src.next_chunk(&mut chunk)? {
            break;
        }
        for fr in chunk.chunks_exact(2) {
            acc += (fr[0] + fr[1]) * 0.5;
            n += 1;
            if n == factor {
                out.push(acc / factor as f32);
                acc = 0.0;
                n = 0;
            }
        }
    }
    if out.len() < (sr * 5.0) as usize {
        return Err(anyhow!("track too short to analyse"));
    }
    Ok((out, sr))
}

fn hann(n: usize) -> Vec<f32> {
    (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (n - 1) as f32).cos()).collect()
}

fn detect_bpm(x: &[f32], sr: f32) -> Option<f32> {
    const N: usize = 1024;
    const HOP: usize = 128;
    let fps = sr / HOP as f32;
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N);
    let win = hann(N);
    let mut buf = fft.make_input_vec();
    let mut spec = fft.make_output_vec();
    let mut prev = vec![0.0f32; N / 2 + 1];

    // Spectral flux on log magnitudes.
    let mut env = Vec::with_capacity(x.len() / HOP);
    let mut i = 0;
    while i + N <= x.len() {
        for (k, b) in buf.iter_mut().enumerate() {
            *b = x[i + k] * win[k];
        }
        fft.process(&mut buf, &mut spec).ok()?;
        let mut flux = 0.0;
        for (k, c) in spec.iter().enumerate() {
            let m = (1.0 + 100.0 * c.norm()).ln();
            let d = m - prev[k];
            if d > 0.0 {
                flux += d;
            }
            prev[k] = m;
        }
        env.push(flux);
        i += HOP;
    }
    if env.len() < (fps * 8.0) as usize {
        return None;
    }

    // Remove the slowly varying level, keep onsets.
    let w = (fps * 0.5) as usize;
    let mut prefix = vec![0.0f64; env.len() + 1];
    for (k, v) in env.iter().enumerate() {
        prefix[k + 1] = prefix[k] + *v as f64;
    }
    let onset: Vec<f32> = (0..env.len())
        .map(|k| {
            let lo = k.saturating_sub(w);
            let hi = (k + w + 1).min(env.len());
            let mean = ((prefix[hi] - prefix[lo]) / (hi - lo) as f64) as f32;
            (env[k] - mean).max(0.0)
        })
        .collect();

    // Generalised autocorrelation at a fractional lag (linear interpolation).
    let acf = |lag: f32| -> f32 {
        let li = lag.floor() as usize;
        let frac = lag - li as f32;
        if li + 1 >= onset.len() {
            return 0.0;
        }
        let mut s = 0.0f32;
        for k in 0..onset.len() - li - 1 {
            let v = onset[k + li] * (1.0 - frac) + onset[k + li + 1] * frac;
            s += onset[k] * v;
        }
        s / (onset.len() - li) as f32
    };
    // Comb score: beat period plus its multiples reinforce the true tempo.
    let comb = |bpm: f32| -> f32 {
        let p = 60.0 * fps / bpm;
        (1..=4).map(|m| acf(p * m as f32) / m as f32).sum()
    };

    // Coarse search 60-200 BPM with a log-Gaussian prior around 120.
    let mut best = (0.0f32, 0.0f32);
    let mut bpm = 60.0f32;
    while bpm <= 200.0 {
        let prior = (-0.5 * ((bpm / 120.0).log2() / 0.9).powi(2)).exp();
        let s = comb(bpm) * prior;
        if s > best.1 {
            best = (bpm, s);
        }
        bpm += 0.5;
    }
    if best.1 <= 0.0 {
        return None;
    }
    // Octave check: if the half-beat position is nearly as strong as the
    // beat itself, the music is really at double speed (e.g. 174 not 87).
    // Off-beat hi-hats in slower music are weaker than this, so they stay.
    if best.0 * 2.0 <= 200.0 {
        let p = 60.0 * fps / best.0;
        let half = acf(p / 2.0);
        let full = acf(p);
        if full > 0.0 && half / full > 0.7 {
            best.0 *= 2.0;
        }
    }
    // Fine search around the winner.
    let mut fine = (best.0, comb(best.0));
    let mut b = best.0 - 1.0;
    while b <= best.0 + 1.0 {
        let s = comb(b);
        if s > fine.1 {
            fine = (b, s);
        }
        b += 0.05;
    }
    let mut t = fine.0;
    while t < 78.0 {
        t *= 2.0;
    }
    while t > 180.0 {
        t /= 2.0;
    }
    Some((t * 10.0).round() / 10.0)
}

const MAJOR_PROFILE: [f32; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE: [f32; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_NAMES: [&str; 12] = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NAMES: [&str; 12] = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];

fn pearson(a: &[f32; 12], b: &[f32; 12]) -> f32 {
    let ma = a.iter().sum::<f32>() / 12.0;
    let mb = b.iter().sum::<f32>() / 12.0;
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        let x = a[i] - ma;
        let y = b[i] - mb;
        num += x * y;
        da += x * x;
        db += y * y;
    }
    if da <= 0.0 || db <= 0.0 {
        0.0
    } else {
        num / (da.sqrt() * db.sqrt())
    }
}

fn detect_key(x: &[f32], sr: f32) -> Option<String> {
    const N: usize = 8192;
    const HOP: usize = 4096;
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N);
    let win = hann(N);
    let mut buf = fft.make_input_vec();
    let mut spec = fft.make_output_vec();

    // Pitch class of every FFT bin in range (C = 0).
    let bin_hz = sr / N as f32;
    let pcs: Vec<Option<usize>> = (0..=N / 2)
        .map(|k| {
            let f = k as f32 * bin_hz;
            if !(55.0..=2000.0).contains(&f) {
                return None;
            }
            let midi = 69.0 + 12.0 * (f / 440.0).log2();
            Some(((midi.round() as i64).rem_euclid(12)) as usize)
        })
        .collect();

    let mut chroma = [0.0f32; 12];
    let mut i = 0;
    while i + N <= x.len() {
        for (k, b) in buf.iter_mut().enumerate() {
            *b = x[i + k] * win[k];
        }
        fft.process(&mut buf, &mut spec).ok()?;
        let mut frame = [0.0f32; 12];
        for (k, c) in spec.iter().enumerate() {
            if let Some(pc) = pcs[k] {
                frame[pc] += c.norm();
            }
        }
        // Normalise per frame so loud passages don't dominate.
        let total: f32 = frame.iter().sum();
        if total > 1e-6 {
            for p in 0..12 {
                chroma[p] += frame[p] / total;
            }
        }
        i += HOP;
    }
    if chroma.iter().sum::<f32>() <= 0.0 {
        return None;
    }

    let mut best = (f32::MIN, String::new());
    for tonic in 0..12 {
        let rotated: [f32; 12] = std::array::from_fn(|p| chroma[(p + tonic) % 12]);
        let maj = pearson(&rotated, &MAJOR_PROFILE);
        let min = pearson(&rotated, &MINOR_PROFILE);
        if maj > best.0 {
            best = (maj, MAJOR_NAMES[tonic].to_owned());
        }
        if min > best.0 {
            best = (min, MINOR_NAMES[tonic].to_owned());
        }
    }
    Some(best.1)
}

pub fn analyse(path: &Path) -> Result<Analysis> {
    let (x, sr) = mono_downsampled(path)?;
    Ok(Analysis { bpm: detect_bpm(&x, sr), key: detect_key(&x, sr) })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic click track at a known tempo.
    fn clicks(bpm: f32, sr: f32, secs: f32) -> Vec<f32> {
        let n = (sr * secs) as usize;
        let period = (60.0 / bpm * sr) as usize;
        let mut x = vec![0.0f32; n];
        let mut t = 0;
        while t < n {
            for k in 0..(sr * 0.01) as usize {
                if t + k < n {
                    x[t + k] = (k as f32 * 0.9).sin() * (1.0 - k as f32 / (sr * 0.01));
                }
            }
            t += period;
        }
        x
    }

    #[test]
    fn finds_tempo_of_click_track() {
        for bpm in [92.0f32, 120.0, 128.0, 174.0] {
            let got = detect_bpm(&clicks(bpm, TARGET_SR, 30.0), TARGET_SR).unwrap();
            assert!((got - bpm).abs() < 1.0, "expected {bpm}, got {got}");
        }
    }

    #[test]
    fn finds_key_of_a_minor_chord() {
        // A minor triad (A, C, E) plus its fifth reinforcing A.
        let sr = TARGET_SR;
        let n = (sr * 20.0) as usize;
        let freqs = [220.0f32, 261.63, 329.63, 440.0, 523.25];
        let x: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f32 / sr;
                freqs.iter().map(|f| (2.0 * std::f32::consts::PI * f * t).sin()).sum::<f32>() * 0.2
            })
            .collect();
        assert_eq!(detect_key(&x, sr).as_deref(), Some("Am"));
    }
}
