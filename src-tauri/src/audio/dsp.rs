//! Output-stage effects on interleaved stereo at the device rate:
//! a 10-band graphic equaliser and headphone crossfeed.

use serde::{Deserialize, Serialize};

pub const EQ_BANDS: [f32; 10] = [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EqSettings {
    pub enabled: bool,
    pub preamp: f32,
    pub gains: [f32; 10],
}

impl Default for EqSettings {
    fn default() -> Self {
        Self { enabled: false, preamp: 0.0, gains: [0.0; 10] }
    }
}

#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: [f32; 2],
    z2: [f32; 2],
}

enum Kind {
    LowShelf,
    Peak,
    HighShelf,
}

impl Biquad {
    /// RBJ audio-EQ-cookbook filters.
    fn design(kind: Kind, f0: f32, gain_db: f32, q: f32, sr: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * (f0 / sr).min(0.49);
        let (cs, sn) = (w0.cos(), w0.sin());
        let alpha = sn / (2.0 * q);
        let (b0, b1, b2, a0, a1, a2) = match kind {
            Kind::Peak => (1.0 + alpha * a, -2.0 * cs, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cs, 1.0 - alpha / a),
            Kind::LowShelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * cs + s),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cs),
                    a * ((a + 1.0) - (a - 1.0) * cs - s),
                    (a + 1.0) + (a - 1.0) * cs + s,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cs),
                    (a + 1.0) + (a - 1.0) * cs - s,
                )
            }
            Kind::HighShelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * cs + s),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cs),
                    a * ((a + 1.0) + (a - 1.0) * cs - s),
                    (a + 1.0) - (a - 1.0) * cs + s,
                    2.0 * ((a - 1.0) - (a + 1.0) * cs),
                    (a + 1.0) - (a - 1.0) * cs - s,
                )
            }
        };
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1: [0.0; 2], z2: [0.0; 2] }
    }

    #[inline]
    fn run(&mut self, ch: usize, x: f32) -> f32 {
        let y = self.b0 * x + self.z1[ch];
        self.z1[ch] = self.b1 * x - self.a1 * y + self.z2[ch];
        self.z2[ch] = self.b2 * x - self.a2 * y;
        y
    }
}

pub struct Equalizer {
    settings: EqSettings,
    sr: u32,
    bands: Vec<Biquad>,
    preamp: f32,
}

impl Equalizer {
    pub fn new(settings: EqSettings, sr: u32) -> Self {
        let mut e = Self { settings: EqSettings::default(), sr, bands: Vec::new(), preamp: 1.0 };
        e.configure(settings, sr);
        e
    }

    pub fn configure(&mut self, settings: EqSettings, sr: u32) {
        if settings == self.settings && sr == self.sr && !self.bands.is_empty() {
            return;
        }
        // One-octave bands; the outer two are shelves so the extremes extend.
        let q = std::f32::consts::SQRT_2;
        self.bands = EQ_BANDS
            .iter()
            .zip(settings.gains.iter())
            .enumerate()
            .filter(|(_, (_, g))| g.abs() > 0.05)
            .map(|(i, (&f, &g))| {
                let (kind, band_q) = match i {
                    0 => (Kind::LowShelf, 0.707),
                    9 => (Kind::HighShelf, 0.707),
                    _ => (Kind::Peak, q),
                };
                Biquad::design(kind, f, g.clamp(-12.0, 12.0), band_q, sr as f32)
            })
            .collect();
        self.preamp = 10f32.powf(settings.preamp.clamp(-12.0, 12.0) / 20.0);
        self.settings = settings;
        self.sr = sr;
    }

    pub fn active(&self) -> bool {
        self.settings.enabled && (!self.bands.is_empty() || (self.preamp - 1.0).abs() > 1e-4)
    }

    pub fn process(&mut self, buf: &mut [f32]) {
        if !self.active() {
            return;
        }
        for fr in buf.chunks_exact_mut(2) {
            for ch in 0..2 {
                let mut x = fr[ch] * self.preamp;
                for b in self.bands.iter_mut() {
                    x = b.run(ch, x);
                }
                fr[ch] = x;
            }
        }
    }
}

/// Headphone crossfeed: mixes the low-frequency *difference* between the
/// channels across, so hard-panned bass and instruments sound less "inside
/// the head" while mono content passes through untouched.
pub struct Crossfeed {
    level: f32,
    coef: f32,
    lp: [f32; 2],
}

impl Crossfeed {
    pub fn new(level: f32, sr: u32) -> Self {
        let mut c = Self { level: 0.0, coef: 0.0, lp: [0.0; 2] };
        c.configure(level, sr);
        c
    }

    pub fn configure(&mut self, level: f32, sr: u32) {
        self.level = level.clamp(0.0, 1.0);
        // One-pole low-pass at 700 Hz, the usual crossfeed corner.
        self.coef = 1.0 - (-2.0 * std::f32::consts::PI * 700.0 / sr as f32).exp();
    }

    pub fn process(&mut self, buf: &mut [f32]) {
        if self.level <= 0.0 {
            return;
        }
        let g = self.level * 0.5;
        for fr in buf.chunks_exact_mut(2) {
            self.lp[0] += (fr[0] - self.lp[0]) * self.coef;
            self.lp[1] += (fr[1] - self.lp[1]) * self.coef;
            let (l, r) = (fr[0], fr[1]);
            fr[0] = l + g * (self.lp[1] - self.lp[0]);
            fr[1] = r + g * (self.lp[0] - self.lp[1]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_eq_is_transparent() {
        let mut eq = Equalizer::new(EqSettings { enabled: true, ..Default::default() }, 48_000);
        let mut buf: Vec<f32> = (0..2000).map(|i| (i as f32 * 0.01).sin()).collect();
        let orig = buf.clone();
        eq.process(&mut buf);
        assert_eq!(buf, orig);
    }

    #[test]
    fn boost_raises_level_at_band() {
        let sr = 48_000.0;
        let mut gains = [0.0; 10];
        gains[5] = 6.0; // 1 kHz
        let mut eq = Equalizer::new(EqSettings { enabled: true, preamp: 0.0, gains }, sr as u32);
        let mut buf = Vec::new();
        for i in 0..48_000 {
            let s = (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr).sin() * 0.25;
            buf.push(s);
            buf.push(s);
        }
        eq.process(&mut buf);
        let peak = buf[48_000..].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        let expected = 0.25 * 10f32.powf(6.0 / 20.0);
        assert!((peak - expected).abs() < 0.02, "peak {peak}, expected {expected}");
    }

    #[test]
    fn crossfeed_leaves_mono_untouched() {
        let mut cf = Crossfeed::new(0.6, 48_000);
        let mut buf: Vec<f32> = (0..2000).flat_map(|i| {
            let s = (i as f32 * 0.03).sin();
            [s, s]
        }).collect();
        let orig = buf.clone();
        cf.process(&mut buf);
        for (a, b) in buf.iter().zip(&orig) {
            assert!((a - b).abs() < 1e-6);
        }
    }
}
