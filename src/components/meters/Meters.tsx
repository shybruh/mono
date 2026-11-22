import { useRef, useState, useEffect } from "react";
import { useMeterCanvas, useMeters } from "@/hooks/useMeters";
import { resolveColor } from "@/lib/accent";
import { cn } from "@/lib/utils";

type Palette = { fg: string; fill: string; track: string; grid: string };
const paletteCache = new WeakMap<Element, { at: number; p: Palette }>();

/** Colours come from CSS so skins and the cover accent apply automatically. */
function colors(el: Element): Palette {
  const now = performance.now();
  const hit = paletteCache.get(el);
  if (hit && now - hit.at < 250) return hit.p;
  const cs = getComputedStyle(el);
  const pick = (name: string, fallback: string) =>
    resolveColor(el.parentElement ?? el, cs.getPropertyValue(name).trim() || fallback);
  const p = {
    fg: pick("--meter-fg", "var(--brand)"),
    fill: pick("--meter-fill", "color-mix(in oklch, var(--brand) 18%, transparent)"),
    track: pick("--meter-track", "var(--muted)"),
    grid: pick("--meter-grid", "color-mix(in oklch, var(--foreground) 8%, transparent)"),
  };
  paletteCache.set(el, { at: now, p });
  return p;
}

export function Spectrum({ className, grid = false }: { className?: string; grid?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const meters = useMeters();
  useMeterCanvas(ref, (ctx, w, h, el) => {
    const c = colors(el);
    if (grid) {
      ctx.fillStyle = c.grid;
      for (const f of [100, 1000, 10000]) {
        const x = (Math.log(f / 20) / Math.log(1000)) * w;
        ctx.fillRect(Math.round(x), 0, 1, h);
      }
    }
    const s = meters.current.current?.spectrum;
    if (!s || !s.length) return;
    const n = s.length;
    const pts: [number, number][] = s.map((v, i) => [(i / (n - 1)) * w, h - v * (h - 1)]);
    ctx.beginPath();
    ctx.moveTo(0, h);
    // Smooth through midpoints.
    ctx.lineTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = c.fill;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ctx.strokeStyle = c.fg;
    ctx.lineWidth = 1.25;
    ctx.stroke();
  });
  return <canvas ref={ref} className={cn("block", className)} />;
}

export function Scope({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const meters = useMeters();
  useMeterCanvas(ref, (ctx, w, h, el) => {
    const c = colors(el);
    ctx.fillStyle = c.grid;
    ctx.fillRect(0, Math.round(h / 2), w, 1);
    const s = meters.current.current?.scope;
    if (!s || !s.length) return;
    // Trigger on a rising zero crossing so the trace holds still.
    let start = 0;
    for (let i = 1; i < s.length / 2; i++) {
      if (s[i - 1] < 0 && s[i] >= 0) {
        start = i;
        break;
      }
    }
    const span = Math.floor(s.length / 2);
    ctx.beginPath();
    for (let i = 0; i < span; i++) {
      const x = (i / (span - 1)) * w;
      const y = h / 2 - s[start + i] * (h / 2) * 0.9;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = c.fg;
    ctx.lineWidth = 1.25;
    ctx.stroke();
  });
  return <canvas ref={ref} className={cn("block", className)} />;
}

const dbToFrac = (db: number) => Math.max(0, Math.min(1, (db + 48) / 48));

export function PeakMeter({ className, vertical = false }: { className?: string; vertical?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const meters = useMeters();
  const hold = useRef({ l: -96, r: -96, tl: 0, tr: 0 });
  useMeterCanvas(ref, (ctx, w, h, el) => {
    const c = colors(el);
    const m = meters.current.current;
    const now = performance.now();
    const l = m?.peakL ?? -96;
    const r = m?.peakR ?? -96;
    const hd = hold.current;
    if (l >= hd.l || now - hd.tl > 1200) {
      hd.l = l;
      hd.tl = now;
    }
    if (r >= hd.r || now - hd.tr > 1200) {
      hd.r = r;
      hd.tr = now;
    }
    const bars: [number, number][] = [
      [dbToFrac(l), dbToFrac(hd.l)],
      [dbToFrac(r), dbToFrac(hd.r)],
    ];
    const gap = 3;
    bars.forEach(([v, hv], i) => {
      if (vertical) {
        const bw = (w - gap) / 2;
        const x = i * (bw + gap);
        ctx.fillStyle = c.track;
        ctx.fillRect(x, 0, bw, h);
        ctx.fillStyle = c.fg;
        ctx.fillRect(x, h - v * h, bw, v * h);
        ctx.fillRect(x, Math.round(h - hv * h), bw, 2);
      } else {
        const bh = (h - gap) / 2;
        const y = i * (bh + gap);
        ctx.fillStyle = c.track;
        ctx.fillRect(0, y, w, bh);
        ctx.fillStyle = c.fg;
        ctx.fillRect(0, y, v * w, bh);
        ctx.fillRect(Math.min(w - 2, Math.round(hv * w)), y, 2, bh);
      }
    });
  });
  return <canvas ref={ref} className={cn("block", className)} />;
}

/** Text readouts updated at ~8 Hz so digits stay legible. */
export function useReadout(pick: (m: NonNullable<ReturnType<typeof useMeters>["current"]["current"]>) => number) {
  const meters = useMeters();
  const [v, setV] = useState<number | null>(null);
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    const id = setInterval(() => {
      const m = meters.current.current;
      setV(m ? pickRef.current(m) : null);
    }, 125);
    return () => clearInterval(id);
  }, [meters]);
  return v;
}

export function fmtDb(v: number | null) {
  if (v == null || v <= -69.9) return "−∞";
  return (v < 0 ? "−" : "") + Math.abs(v).toFixed(1);
}
