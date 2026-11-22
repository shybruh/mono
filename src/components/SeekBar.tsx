import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { useCanvasLoop } from "@/hooks/useMeters";
import { resolveColor } from "@/lib/accent";
import { cn, fmtTime } from "@/lib/utils";

const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const BAR = 3;

/**
 * The waveform is the seek bar: always visible, click or drag to scrub.
 * Bars grow in from the left when a new track's envelope arrives.
 */
export function SeekBar() {
  const track = useStore((s) => s.track);
  const pos = useStore((s) => s.pos);
  const duration = useStore((s) => s.duration);
  const loopA = useStore((s) => s.player.loopA);
  const loopB = useStore((s) => s.player.loopB);
  const style = useStore((s) => s.config?.seekStyle ?? "waveform");
  const wave = style === "waveform";

  const zone = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const grow = useRef({ p: 1, prev: null as number[] | null });
  const path = track?.meta.path;

  useEffect(() => {
    if (!path || !wave) return setPeaks(null);
    let live = true;
    api
      .waveform(path, 1600)
      .then((w) => {
        if (!live) return;
        grow.current.prev = peaks;
        grow.current.p = 0;
        setPeaks(w);
      })
      .catch(() => live && setPeaks(null));
    return () => {
      live = false;
    };
  }, [path, wave]);

  const frac = (clientX: number) => {
    const r = zone.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  const shownPos = drag != null ? drag * duration : pos;
  const played = duration > 0 ? Math.min(1, shownPos / duration) : 0;

  useCanvasLoop(canvas, (ctx, w, h, el) => {
    const parent = el.parentElement!;
    const cPlayed = resolveColor(parent, "var(--brand)");
    const cPlayedHover = resolveColor(parent, "color-mix(in oklch, var(--brand) 65%, var(--background))");
    const cRest = resolveColor(parent, "var(--input)");
    const cRestHover = resolveColor(parent, "var(--muted-foreground)");
    const cLine = resolveColor(parent, "var(--foreground)");

    if (!wave) {
      // Plain bar: 3 px track, accent fill, loop band, knob.
      const y = Math.round(h / 2) - 1.5;
      const hx = drag != null ? drag * w : hoverX;
      ctx.fillStyle = cRest;
      ctx.beginPath();
      ctx.roundRect(0, y, w, 3, 1.5);
      ctx.fill();
      if (loopA != null && duration > 0) {
        const a = (loopA / duration) * w;
        const b = loopB != null ? (loopB / duration) * w : a + 2;
        ctx.fillStyle = resolveColor(parent, "color-mix(in oklch, var(--brand) 45%, transparent)");
        ctx.fillRect(a, y - 3, Math.max(2, b - a), 9);
      }
      ctx.fillStyle = cPlayed;
      ctx.beginPath();
      ctx.roundRect(0, y, played * w, 3, 1.5);
      ctx.fill();
      if (hx != null) {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = cLine;
        ctx.fillRect(Math.round(hx), y - 3, 1, 9);
        ctx.globalAlpha = 1;
      }
      if (duration > 0) {
        ctx.fillStyle = cLine;
        ctx.beginPath();
        ctx.arc(played * w, h / 2, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    const g = grow.current;
    if (g.p < 1) g.p = Math.min(1, g.p + 0.035);

    const n = Math.floor(w / BAR);
    const px = played * w;
    const hx = drag != null ? drag * w : hoverX;
    const mid = h / 2;

    for (let i = 0; i < n; i++) {
      const x = i * BAR;
      const f = i / n;
      const sample = (arr: number[] | null) =>
        arr ? arr[Math.min(arr.length - 1, Math.floor(f * arr.length))] : 0;
      // Sweep left to right: each bar morphs from the old envelope to the new one.
      const k = easeOut(Math.max(0, Math.min(1, g.p * 1.6 - f * 0.6)));
      const v = peaks ? sample(g.prev) * (1 - k) + sample(peaks) * k : 0;
      const bh = Math.max(2, v * (h - 2));
      const between = hx != null && ((x >= px && x < hx) || (x < px && x >= hx));
      ctx.fillStyle = x < px ? (between ? cPlayedHover : cPlayed) : between ? cRestHover : cRest;
      // Symmetrical around the centre line.
      ctx.fillRect(x, mid - bh / 2, BAR - 1, bh);
    }

    if (loopA != null && duration > 0) {
      const la = (loopA / duration) * w;
      const lb = loopB != null ? (loopB / duration) * w : la;
      ctx.fillStyle = resolveColor(parent, "color-mix(in oklch, var(--brand) 16%, transparent)");
      ctx.fillRect(la, 0, Math.max(1, lb - la), h);
      ctx.fillStyle = cPlayed;
      ctx.fillRect(Math.round(la), 0, 1, h);
      if (loopB != null) ctx.fillRect(Math.round(lb), 0, 1, h);
    }

    if (duration > 0) {
      ctx.fillStyle = cLine;
      ctx.fillRect(Math.round(px), 0, 1, h);
    }
    if (hx != null) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = cLine;
      ctx.fillRect(Math.round(hx), 0, 1, h);
      ctx.globalAlpha = 1;
    }
  });

  const tipX = drag != null ? drag * (zone.current?.clientWidth ?? 0) : hoverX;
  const tipTime = tipX != null && zone.current ? (tipX / zone.current.clientWidth) * duration : null;

  return (
    <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground tabular-nums">
      <span className="w-12 text-right">{fmtTime(shownPos)}</span>
      <div
        ref={zone}
        className={cn("relative flex-1 cursor-pointer", wave ? "h-12" : "h-3.5")}
        onPointerMove={(e) => {
          const r = zone.current!.getBoundingClientRect();
          const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
          setHoverX(x);
          if (drag != null) setDrag(x / r.width);
        }}
        onPointerLeave={() => drag == null && setHoverX(null)}
        onPointerDown={(e) => {
          if (!duration) return;
          zone.current!.setPointerCapture(e.pointerId);
          setDrag(frac(e.clientX));
        }}
        onPointerUp={(e) => {
          if (drag == null) return;
          const f = frac(e.clientX);
          setDrag(null);
          api.seek(f * duration);
          useStore.setState({ pos: f * duration });
        }}
      >
        <canvas ref={canvas} className="block h-full w-full" />
        {tipTime != null && duration > 0 && (
          <span
            className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded bg-secondary px-1.5 py-0.5 text-[11px] text-foreground"
            style={{ left: tipX ?? 0 }}
          >
            {fmtTime(tipTime)}
          </span>
        )}
      </div>
      <span className="w-12">{fmtTime(duration)}</span>
    </div>
  );
}
