//! Streaming stereo sample-rate conversion (FFT, fixed input chunks).

use rubato::{FftFixedIn, Resampler};

const CHUNK: usize = 1024;

pub struct Resample {
    pub from: u32,
    inner: FftFixedIn<f32>,
    acc: [Vec<f32>; 2],
}

impl Resample {
    pub fn new(from: u32, to: u32) -> Option<Self> {
        let inner = FftFixedIn::<f32>::new(from as usize, to as usize, CHUNK, 2, 2).ok()?;
        Some(Self { from, inner, acc: [Vec::with_capacity(CHUNK * 2), Vec::with_capacity(CHUNK * 2)] })
    }

    pub fn reset(&mut self) {
        self.inner.reset();
        self.acc[0].clear();
        self.acc[1].clear();
    }

    /// Feeds interleaved stereo; appends whatever output is ready to `out`.
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for fr in input.chunks_exact(2) {
            self.acc[0].push(fr[0]);
            self.acc[1].push(fr[1]);
        }
        loop {
            let need = self.inner.input_frames_next();
            if self.acc[0].len() < need {
                break;
            }
            let block = [&self.acc[0][..need], &self.acc[1][..need]];
            if let Ok(res) = self.inner.process(&block, None) {
                let n = res[0].len();
                out.reserve(n * 2);
                for i in 0..n {
                    out.push(res[0][i]);
                    out.push(res[1][i]);
                }
            }
            self.acc[0].drain(..need);
            self.acc[1].drain(..need);
        }
    }
}
