//! Amplitude envelope for the seek-bar waveform: decode the whole file once,
//! keep the peak per bucket. Cached per path + mtime.

use std::collections::HashMap;
use std::path::Path;
use std::time::SystemTime;

use anyhow::Result;
use parking_lot::Mutex;

use super::source::Source;

#[derive(Default)]
pub struct WaveformCache {
    map: Mutex<HashMap<(String, usize), (Option<SystemTime>, Vec<f32>)>>,
}

impl WaveformCache {
    pub fn get(&self, path: &Path, buckets: usize) -> Result<Vec<f32>> {
        let key = (path.to_string_lossy().into_owned(), buckets);
        let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        if let Some((t, w)) = self.map.lock().get(&key) {
            if *t == mtime {
                return Ok(w.clone());
            }
        }
        let w = compute(path, buckets)?;
        let mut map = self.map.lock();
        if map.len() > 64 {
            map.clear();
        }
        map.insert(key, (mtime, w.clone()));
        Ok(w)
    }
}

fn compute(path: &Path, buckets: usize) -> Result<Vec<f32>> {
    let mut src = Source::open(path)?;
    let mut frames: Vec<f32> = Vec::new();
    let mut chunk = Vec::with_capacity(4096);
    // Mono peak per 256-frame block keeps memory small for long mixes.
    const BLOCK: usize = 256;
    let mut acc = 0.0f32;
    let mut n = 0usize;
    loop {
        chunk.clear();
        if !src.next_chunk(&mut chunk)? {
            break;
        }
        for fr in chunk.chunks_exact(2) {
            acc = acc.max(fr[0].abs().max(fr[1].abs()));
            n += 1;
            if n == BLOCK {
                frames.push(acc);
                acc = 0.0;
                n = 0;
            }
        }
    }
    if n > 0 {
        frames.push(acc);
    }
    let buckets = buckets.clamp(16, 8192);
    if frames.is_empty() {
        return Ok(vec![0.0; buckets]);
    }
    let mut out = Vec::with_capacity(buckets);
    for b in 0..buckets {
        let i0 = b * frames.len() / buckets;
        let i1 = ((b + 1) * frames.len() / buckets).max(i0 + 1).min(frames.len());
        out.push(frames[i0..i1].iter().copied().fold(0.0, f32::max));
    }
    let max = out.iter().copied().fold(0.0f32, f32::max).max(1e-6);
    for v in out.iter_mut() {
        *v = (*v / max).min(1.0);
    }
    Ok(out)
}
