import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { useCanvasLoop } from "@/hooks/useMeters";
import { resolveColor } from "@/lib/accent";
import { cn, fmtTime } from "@/lib/utils";

const LINGER_MS = 700;
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);

export function SeekBar() {
  const track = useStore((s) => s.track);
  const pos = useStore((s) => s.pos);
  const duration = useStore((s) => s.duration);
  const loopA = useStore((s) => s.player.loopA);
  const loopB = useStore((s) => s.player.loopB);

  const zone = useRef<HTMLDivElement>(null);
  const barCanvas = useRef<HTMLCanvasElement>(null);
  const waveCanvas = useRef<HTMLCanvasElement>(null);

  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [open, setOpen] = useState(false);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);

  const anim = useRef({ p: 0, target: 0, originX: 0 });
  const hideTimer = useRef<number | undefined>(undefined);
  const path = track?.meta.path;

  useEffect(() => {
    setPeaks(null);
    if (!path) return;
    let live = true;
    api
      .waveform(path, 1600)
      .then((w) => live && setPeaks(w))
      .catch(() => live && setPeaks(null));
    return () => {
      live = false;
    };
  }, [path]);

  const frac = (clientX: number) => {
    const r = zone.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  const shownPos = drag != null ? drag * duration : pos;
  const played = duration > 0 ? Math.min(1, shownPos / duration) : 0;

  const show = (clientX: number) => {
    window.clearTimeout(hideTimer.current);
    if (!open) {
      const r = zone.current!.getBoundingClientRect();
      anim.current.originX = clientX - r.left;
      anim.current.p = 0;
      setOpen(true);
    }
    anim.current.target = 1;
  };
  const hide = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (drag != null) return;
      anim.current.target = 0;
      setOpen(false);
      setHoverX(null);
    }, LINGER_MS);
  };

  // Static bar.
  useCanvasLoop(barCanvas, (ctx, w, h, el) => {
    const brand = resolveColor(el.parentElement!, "var(--brand)");
    const trackCol = resolveColor(el.parentElement!, "var(--input)");
    const fg = resolveColor(el.parentElement!, "var(--foreground)");
    const y = Math.round(h / 2) - 1.5;
    ctx.fillStyle = trackCol;
    ctx.beginPath();
    ctx.roundRect(0, y, w, 3, 1.5);
    ctx.fill();
    if (loopA != null && duration > 0) {
      const a = (loopA / duration) * w;
      const b = loopB != null ? (loopB / duration) * w : a + 2;
      ctx.fillStyle = resolveColor(el.parentElement!, "color-mix(in oklch, var(--brand) 45%, transparent)");
      ctx.fillRect(a, y - 3, Math.max(2, b - a), 9);
    }
    ctx.fillStyle = brand;
    ctx.beginPath();
    ctx.roundRect(0, y, played * w, 3, 1.5);
    ctx.fill();
    if (hoverX != null) {
      ctx.fillStyle = resolveColor(el.parentElement!, "color-mix(in oklch, var(--foreground) 50%, transparent)");
      ctx.fillRect(Math.round(hoverX), y - 3, 1, 9);
    }
    if (duration > 0) {
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(played * w, h / 2, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // Floating waveform.
  useCanvasLoop(
    waveCanvas,
    (ctx, w, h, el) => {
      const a = anim.current;
      a.p += (a.target - a.p) * 0.16;
      if (Math.abs(a.target - a.p) < 0.003) a.p = a.target;
      if (!peaks || a.p <= 0.001) return;

      const parent = el.parentElement!;
      const cPlayed = resolveColor(parent, "var(--brand)");
      const cPlayedHover = resolveColor(parent, "color-mix(in oklch, var(--brand) 70%, var(--background))");
      const cRest = resolveColor(parent, "var(--input)");
      const cRestHover = resolveColor(parent, "var(--muted-foreground)");
      const cLine = resolveColor(parent, "var(--foreground)");

      const gap = 3;
      const n = Math.floor(w / gap);
      const px = played * w;
      const hx = drag != null ? drag * w : hoverX;
      for (let i = 0; i < n; i++) {
        const x = i * gap;
        const v = peaks[Math.min(peaks.length - 1, Math.floor((i / n) * peaks.length))];
        const dist = Math.abs(x - a.originX) / w;
        const k = easeOut(Math.max(0, Math.min(1, a.p * 1.8 - dist * 1.4)));
        const bh = Math.max(2, 2 + (v * h - 2) * k);
        const between = hx != null && ((x >= px && x < hx) || (x < px && x >= hx));
        ctx.fillStyle = x < px ? (between ? cPlayedHover : cPlayed) : between ? cRestHover : cRest;
        ctx.fillRect(x, h - bh, gap - 1, bh);
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
      ctx.globalAlpha = a.p;
      ctx.fillStyle = cLine;
      ctx.fillRect(Math.round(px), 0, 1, h);
      if (hx != null) {
        ctx.globalAlpha = a.p * 0.55;
        ctx.fillRect(Math.round(hx), 0, 1, h);
      }
      ctx.globalAlpha = 1;
    },
    open || anim.current.p > 0,
  );

  const tipX = drag != null ? drag * (zone.current?.clientWidth ?? 0) : hoverX;
  const tipTime =
    tipX != null && zone.current ? (tipX / zone.current.clientWidth) * duration : null;

  return (
    <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground tabular-nums">
      <span className="w-12 text-right">{fmtTime(shownPos)}</span>
      <div
        ref={zone}
        className="relative flex h-3.5 flex-1 cursor-pointer items-center"
        onPointerEnter={(e) => show(e.clientX)}
        onPointerLeave={hide}
        onPointerMove={(e) => {
          const r = zone.current!.getBoundingClientRect();
          const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
          setHoverX(x);
          show(e.clientX);
          if (drag != null) setDrag(x / r.width);
        }}
        onPointerDown={(e) => {
          if (!duration) return;
          (e.target as Element).setPointerCapture?.(e.pointerId);
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
        <div
          className={cn(
            "absolute -inset-x-2 bottom-4 z-20 h-[76px] translate-y-2 bg-linear-to-t from-background from-70% to-transparent px-2 pt-3 opacity-0 transition-[opacity,transform] duration-200 ease-out",
            open && peaks && "translate-y-0 opacity-100",
            !open && "pointer-events-none",
          )}
        >
          <canvas ref={waveCanvas} className="block h-full w-full" />
        </div>
        <canvas ref={barCanvas} className="absolute inset-0 block h-full w-full" />
        {tipTime != null && open && (
          <span
            className="pointer-events-none absolute bottom-[84px] -translate-x-1/2 rounded bg-secondary px-1.5 py-0.5 text-[11px] text-foreground"
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
