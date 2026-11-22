import { useEffect, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, on, type Meters } from "@/lib/api";

// One listener per window, shared by every meter on screen. The backend only
// runs analysis while at least one consumer is mounted.
const latest: { current: Meters | null; at: number } = { current: null, at: 0 };
let users = 0;
let unlisten: Promise<UnlistenFn> | null = null;

function acquire() {
  users += 1;
  if (users === 1) {
    unlisten = on.meters((m) => {
      latest.current = m;
      latest.at = performance.now();
    });
    api.setMeters(true);
  }
}

function release() {
  users = Math.max(0, users - 1);
  if (users === 0) {
    api.setMeters(false);
    unlisten?.then((u) => u());
    unlisten = null;
    latest.current = null;
  }
}

export function useMeters(enabled = true) {
  const ref = useRef(latest);
  useEffect(() => {
    if (!enabled) return;
    acquire();
    return release;
  }, [enabled]);
  return ref;
}

/** requestAnimationFrame loop that redraws a canvas at device pixel ratio. */
export function useCanvasLoop(
  canvas: React.RefObject<HTMLCanvasElement | null>,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, el: HTMLCanvasElement) => void,
  active = true,
) {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      const el = canvas.current;
      if (el) {
        const dpr = window.devicePixelRatio || 1;
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
          el.width = Math.round(w * dpr);
          el.height = Math.round(h * dpr);
        }
        const ctx = el.getContext("2d");
        if (ctx && w > 0 && h > 0) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, w, h);
          drawRef.current(ctx, w, h, el);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [canvas, active]);
}
