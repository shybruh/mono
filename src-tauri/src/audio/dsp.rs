//! Output-stage effects on interleaved stereo at the device rate:
//! a parametric equaliser and headphone crossfeed.

use serde::{Deserialize, Serialize};

pub const MAX_BANDS: usize = 16;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum BandKind {
    #[default]
    Bell,
    LowShelf,
    HighShelf,
    LowCut,
    HighCut,
    Notch,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EqBand {
    pub kind: BandKind,
    /// Hz
    pub freq: f32,
    /// dB (bells and shelves only)
    pub gain: f32,
    pub q: f32,
    /// Cut slope in dB/octave: 12, 24 or 48.
    pub slope: u32,
    pub enabled: bool,
}

impl Default for EqBand {
    fn default() -> Self {
        Self { kind: BandKind::Bell, freq: 1000.0, gain: 0.0, q: 1.0, slope: 12, enabled: true }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EqSettings {
    pub enabled: bool,
    pub preamp: f32,
    pub bands: Vec<EqBand>,
}

impl Default for EqSettings {
    fn default() -> Self {
        Self { enabled: false, preamp: 0.0, bands: Vec::new() }
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

impl Biquad {
    fn new(b: [f64; 3], a: [f64; 3]) -> Self {
        let a0 = a[0];
        Self {
            b0: (b[0] / a0) as f32,
            b1: (b[1] / a0) as f32,
            b2: (b[2] / a0) as f32,
            a1: (a[1] / a0) as f32,
            a2: (a[2] / a0) as f32,
            z1: [0.0; 2],
            z2: [0.0; 2],
        }
    }

    #[inline]
    fn run(&mut self, ch: usize, x: f32) -> f32 {
        let y = self.b0 * x + self.z1[ch];
        self.z1[ch] = self.b1 * x - self.a1 * y + self.z2[ch];
        self.z2[ch] = self.b2 * x - self.a2 * y;
        y
    }
}

/// Butterworth section Qs for cascaded cut filters (2nd, 4th, 8th order).
fn cut_qs(slope: u32) -> &'static [f64] {
    match slope {
        48 => &[0.5098, 0.6013, 0.9000, 2.5629],
        24 => &[0.5412, 1.3066],
        _ => &[std::f64::consts::FRAC_1_SQRT_2],
    }
}

/// RBJ audio-EQ-cookbook sections for one band.
fn design(band: &EqBand, sr: f64) -> Vec<Biquad> {
    let f0 = (band.freq as f64).clamp(10.0, sr * 0.49);
    let w0 = 2.0 * std::f64::consts::PI * f0 / sr;
    let (cs, sn) = (w0.cos(), w0.sin());
    let a = 10f64.powf(band.gain.clamp(-30.0, 30.0) as f64 / 40.0);
    let q = (band.q as f64).clamp(0.1, 40.0);
    let alpha = |q: f64| sn / (2.0 * q);
    match band.kind {
        BandKind::Bell => {
            let al = alpha(q);
            vec![Biquad::new([1.0 + al * a, -2.0 * cs, 1.0 - al * a], [1.0 + al / a, -2.0 * cs, 1.0 - al / a])]
        }
        BandKind::Notch => {
            let al = alpha(q);
            vec![Biquad::new([1.0, -2.0 * cs, 1.0], [1.0 + al, -2.0 * cs, 1.0 - al])]
        }
        BandKind::LowShelf | BandKind::HighShelf => {
            // Q here is the shelf slope-ish "Q"; 0.707 is the classic shape.
            let al = alpha(q);
            let s = 2.0 * a.sqrt() * al;
            let (ap, am) = (a + 1.0, a - 1.0);
            if band.kind == BandKind::LowShelf {
                vec![Biquad::new(
                    [a * (ap - am * cs + s), 2.0 * a * (am - ap * cs), a * (ap - am * cs - s)],
                    [ap + am * cs + s, -2.0 * (am + ap * cs), ap + am * cs - s],
                )]
            } else {
                vec![Biquad::new(
                    [a * (ap + am * cs + s), -2.0 * a * (am + ap * cs), a * (ap + am * cs - s)],
                    [ap - am * cs + s, 2.0 * (am - ap * cs), ap - am * cs - s],
                )]
            }
        }
        BandKind::LowCut | BandKind::HighCut => cut_qs(band.slope)
            .iter()
            .map(|&sq| {
                // The band's Q shapes the corner of the first section only.
                let sq = if sq == std::f64::consts::FRAC_1_SQRT_2 { q.min(10.0) } else { sq };
                let al = alpha(sq);
                if band.kind == BandKind::LowCut {
                    Biquad::new([(1.0 + cs) / 2.0, -(1.0 + cs), (1.0 + cs) / 2.0], [1.0 + al, -2.0 * cs, 1.0 - al])
                } else {
                    Biquad::new([(1.0 - cs) / 2.0, 1.0 - cs, (1.0 - cs) / 2.0], [1.0 + al, -2.0 * cs, 1.0 - al])
                }
            })
            .collect(),
    }
}

pub struct Equalizer {
    settings: EqSettings,
    sr: u32,
    sections: Vec<Biquad>,
    preamp: f32,
}

impl Equalizer {
    pub fn new(settings: EqSettings, sr: u32) -> Self {
        let mut e = Self { settings: EqSettings { enabled: !settings.enabled, ..Default::default() }, sr: 0, sections: Vec::new(), preamp: 1.0 };
        e.configure(settings, sr);
        e
    }

    pub fn configure(&mut self, settings: EqSettings, sr: u32) {
        if settings == self.settings && sr == self.sr {
            return;
        }
        // Keep filter memory when only parameters move, so dragging a node
        // doesn't click; reset when the section count changes.
        let old: Vec<Biquad> = std::mem::take(&mut self.sections);
        let mut sections: Vec<Biquad> = settings
            .bands
            .iter()
            .take(MAX_BANDS)
            .filter(|b| b.enabled && !(matches!(b.kind, BandKind::Bell | BandKind::LowShelf | BandKind::HighShelf) && b.gain.abs() < 0.01))
            .flat_map(|b| design(b, sr as f64))
            .collect();
        if old.len() == sections.len() {
            for (n, o) in sections.iter_mut().zip(old.iter()) {
                n.z1 = o.z1;
                n.z2 = o.z2;
            }
        }
        self.sections = sections;
        self.preamp = 10f32.powf(settings.preamp.clamp(-24.0, 24.0) / 20.0);
        self.settings = settings;
        self.sr = sr;
    }

    pub fn active(&self) -> bool {
        self.settings.enabled && (!self.sections.is_empty() || (self.preamp - 1.0).abs() > 1e-4)
    }

    pub fn process(&mut self, buf: &mut [f32]) {
        if !self.active() {
            return;
        }
        for fr in buf.chunks_exact_mut(2) {
            for ch in 0..2 {
                let mut x = fr[ch] * self.preamp;
                for s in self.sections.iter_mut() {
                    x = s.run(ch, x);
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

    fn tone(freq: f32, sr: f32, secs: f32) -> Vec<f32> {
        (0..(sr * secs) as usize)
            .flat_map(|i| {
                let s = (2.0 * std::f32::consts::PI * freq * i as f32 / sr).sin() * 0.25;
                [s, s]
            })
            .collect()
    }

    fn peak_after_settle(buf: &[f32]) -> f32 {
        buf[buf.len() / 2..].iter().fold(0.0f32, |m, v| m.max(v.abs()))
    }

    #[test]
    fn flat_eq_is_transparent() {
        let mut eq = Equalizer::new(EqSettings { enabled: true, ..Default::default() }, 48_000);
        let mut buf = tone(440.0, 48_000.0, 0.1);
        let orig = buf.clone();
        eq.process(&mut buf);
        assert_eq!(buf, orig);
    }

    #[test]
    fn bell_boost_raises_level_at_centre() {
        let band = EqBand { kind: BandKind::Bell, freq: 1000.0, gain: 6.0, q: 1.0, ..Default::default() };
        let mut eq = Equalizer::new(EqSettings { enabled: true, preamp: 0.0, bands: vec![band] }, 48_000);
        let mut buf = tone(1000.0, 48_000.0, 1.0);
        eq.process(&mut buf);
        let expected = 0.25 * 10f32.powf(6.0 / 20.0);
        assert!((peak_after_settle(&buf) - expected).abs() < 0.02);
    }

    #[test]
    fn low_cut_removes_rumble_but_keeps_mids() {
        let band = EqBand { kind: BandKind::LowCut, freq: 200.0, q: 0.707, slope: 24, ..Default::default() };
        let settings = EqSettings { enabled: true, preamp: 0.0, bands: vec![band] };
        let mut low = tone(30.0, 48_000.0, 1.0);
        Equalizer::new(settings.clone(), 48_000).process(&mut low);
        let mut mid = tone(2000.0, 48_000.0, 1.0);
        Equalizer::new(settings, 48_000).process(&mut mid);
        assert!(peak_after_settle(&low) < 0.25 * 0.02, "30 Hz should be ~-40 dB or lower");
        assert!((peak_after_settle(&mid) - 0.25).abs() < 0.01, "2 kHz should pass");
    }

    #[test]
    fn notch_kills_its_frequency() {
        let band = EqBand { kind: BandKind::Notch, freq: 1000.0, q: 4.0, ..Default::default() };
        let mut eq = Equalizer::new(EqSettings { enabled: true, preamp: 0.0, bands: vec![band] }, 48_000);
        let mut buf = tone(1000.0, 48_000.0, 1.0);
        eq.process(&mut buf);
        assert!(peak_after_settle(&buf) < 0.01);
    }

    #[test]
    fn crossfeed_leaves_mono_untouched() {
        let mut cf = Crossfeed::new(0.6, 48_000);
        let mut buf = tone(300.0, 48_000.0, 0.05);
        let orig = buf.clone();
        cf.process(&mut buf);
        for (a, b) in buf.iter().zip(&orig) {
            assert!((a - b).abs() < 1e-6);
        }
    }
}
