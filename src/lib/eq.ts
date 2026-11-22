// Parametric EQ model and frequency response. The filter design mirrors
// src-tauri/src/audio/dsp.rs so the drawn curve is what you hear.

export type BandKind = "bell" | "lowShelf" | "highShelf" | "lowCut" | "highCut" | "notch";

export interface EqBand {
  kind: BandKind;
  freq: number;
  gain: number;
  q: number;
  slope: 12 | 24 | 48;
  enabled: boolean;
}

export interface EqSettings {
  enabled: boolean;
  preamp: number;
  bands: EqBand[];
}

export const MAX_BANDS = 16;
export const F_MIN = 20;
export const F_MAX = 20000;

export const KIND_LABEL: Record<BandKind, string> = {
  bell: "Bell",
  lowShelf: "Low shelf",
  highShelf: "High shelf",
  lowCut: "Low cut",
  highCut: "High cut",
  notch: "Notch",
};

export const hasGain = (k: BandKind) => k === "bell" || k === "lowShelf" || k === "highShelf";
export const isCut = (k: BandKind) => k === "lowCut" || k === "highCut";

export function newBand(freq: number, gain = 0, kind: BandKind = "bell"): EqBand {
  return { kind, freq, gain, q: kind === "bell" ? 1 : 0.707, slope: 12, enabled: true };
}

type Section = [number, number, number, number, number, number];

const CUT_QS: Record<number, number[]> = {
  12: [Math.SQRT1_2],
  24: [0.5412, 1.3066],
  48: [0.5098, 0.6013, 0.9, 2.5629],
};

function design(b: EqBand, sr: number): Section[] {
  const f0 = Math.min(Math.max(b.freq, 10), sr * 0.49);
  const w0 = (2 * Math.PI * f0) / sr;
  const cs = Math.cos(w0);
  const sn = Math.sin(w0);
  const A = Math.pow(10, Math.max(-30, Math.min(30, b.gain)) / 40);
  const q = Math.max(0.1, Math.min(40, b.q));
  const alpha = (qq: number) => sn / (2 * qq);
  switch (b.kind) {
    case "bell": {
      const al = alpha(q);
      return [[1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A]];
    }
    case "notch": {
      const al = alpha(q);
      return [[1, -2 * cs, 1, 1 + al, -2 * cs, 1 - al]];
    }
    case "lowShelf":
    case "highShelf": {
      const al = alpha(q);
      const s = 2 * Math.sqrt(A) * al;
      const ap = A + 1;
      const am = A - 1;
      return b.kind === "lowShelf"
        ? [[A * (ap - am * cs + s), 2 * A * (am - ap * cs), A * (ap - am * cs - s), ap + am * cs + s, -2 * (am + ap * cs), ap + am * cs - s]]
        : [[A * (ap + am * cs + s), -2 * A * (am + ap * cs), A * (ap + am * cs - s), ap - am * cs + s, 2 * (am - ap * cs), ap - am * cs - s]];
    }
    case "lowCut":
    case "highCut":
      return (CUT_QS[b.slope] ?? CUT_QS[12]).map((sq) => {
        const qq = sq === Math.SQRT1_2 ? Math.min(q, 10) : sq;
        const al = alpha(qq);
        return b.kind === "lowCut"
          ? [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al]
          : [(1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al];
      });
  }
}

function sectionDb([b0, b1, b2, a0, a1, a2]: Section, w: number): number {
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2;
  const ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2;
  const di = -(a1 * s1 + a2 * s2);
  const mag = Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  return 20 * Math.log10(Math.max(mag, 1e-9));
}

/** Response of one band (dB) at each frequency. */
export function bandResponse(b: EqBand, freqs: number[], sr = 48000): number[] {
  const secs = design(b, sr);
  return freqs.map((f) => {
    const w = (2 * Math.PI * f) / sr;
    return secs.reduce((sum, s) => sum + sectionDb(s, w), 0);
  });
}

/** Combined response (dB) including pre-amp. */
export function totalResponse(eq: EqSettings, freqs: number[], sr = 48000): number[] {
  const out = freqs.map(() => eq.preamp);
  for (const b of eq.bands) {
    if (!b.enabled) continue;
    const r = bandResponse(b, freqs, sr);
    for (let i = 0; i < out.length; i++) out[i] += r[i];
  }
  return out;
}

export function logFreqs(n: number): number[] {
  const lo = Math.log(F_MIN);
  const hi = Math.log(F_MAX);
  return Array.from({ length: n }, (_, i) => Math.exp(lo + ((hi - lo) * i) / (n - 1)));
}

export const fmtFreq = (f: number) =>
  f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, "")} kHz` : `${Math.round(f)} Hz`;

export function parseFreq(s: string): number | null {
  const m = /^\s*([\d.]+)\s*(k?)/i.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(v) ? Math.max(F_MIN, Math.min(F_MAX, v)) : null;
}

export const PRESETS: Record<string, EqBand[]> = {
  Flat: [],
  "Bass boost": [{ ...newBand(90, 5, "lowShelf") }],
  Air: [{ ...newBand(10000, 4, "highShelf") }],
  Warm: [
    { ...newBand(200, 3, "lowShelf") },
    { ...newBand(8000, -2.5, "highShelf") },
  ],
  Vocal: [
    { ...newBand(90, 0, "lowCut"), slope: 24 },
    { ...newBand(300, -2), q: 1.2 },
    { ...newBand(3000, 3), q: 1 },
  ],
  Loudness: [
    { ...newBand(80, 5, "lowShelf") },
    { ...newBand(2500, -1.5), q: 0.8 },
    { ...newBand(10000, 4, "highShelf") },
  ],
  "Rumble filter": [{ ...newBand(30, 0, "lowCut"), slope: 24 }],
};
