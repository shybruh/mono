// Derives the UI accent (OKLCH hue + chroma) from cover art.

const DEFAULT = { h: 263, c: 0.17 };

function srgbToLinear(v: number) {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function toOklch(r: number, g: number, b: number) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

export async function accentFromImage(src: string): Promise<{ h: number; c: number }> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const size = 40;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return DEFAULT;
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  // Hue histogram weighted by chroma, so the most vivid dominant colour wins.
  const bins = new Float64Array(36);
  const chromaSum = new Float64Array(36);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const { L, C, h } = toOklch(data[i], data[i + 1], data[i + 2]);
    if (L < 0.15 || L > 0.97 || C < 0.03) continue;
    const bin = Math.floor(h / 10) % 36;
    const w = C * C;
    bins[bin] += w;
    chromaSum[bin] += C * w;
    total += w;
  }
  if (total < 0.5) return { h: DEFAULT.h, c: 0.015 };
  let best = 0;
  for (let i = 1; i < 36; i++) {
    const score = bins[i] + 0.5 * (bins[(i + 35) % 36] + bins[(i + 1) % 36]);
    const bestScore = bins[best] + 0.5 * (bins[(best + 35) % 36] + bins[(best + 1) % 36]);
    if (score > bestScore) best = i;
  }
  const c = chromaSum[best] / Math.max(bins[best], 1e-9);
  return { h: best * 10 + 5, c: Math.min(0.2, Math.max(0.08, c)) };
}

export function applyAccent(a: { h: number; c: number } | null) {
  const v = a ?? DEFAULT;
  const root = document.documentElement.style;
  root.setProperty("--accent-h", String(v.h));
  root.setProperty("--accent-c", String(v.c));
}

/** Resolves a CSS colour (incl. var()/calc) to something canvas accepts. */
const probeCache = new WeakMap<Element, HTMLSpanElement>();
export function resolveColor(el: Element, value: string): string {
  let probe = probeCache.get(el);
  if (!probe) {
    probe = document.createElement("span");
    probe.style.display = "none";
    el.appendChild(probe);
    probeCache.set(el, probe);
  }
  probe.style.color = value;
  return getComputedStyle(probe).color;
}
