import { useEffect, useRef } from "react";
import { api, on, type Meters } from "@/lib/api";

// One listener per window, shared by every meter on screen. The backend only
// runs analysis while at least one window wants meters.
//
// On/off requests are coalesced and carry a strictly increasing sequence
// number, so out-of-order IPC (StrictMode double mounts, quick toggles,
// page reloads) can never leave the backend in a stale state.
const latest: { current: Meters | null; at: number } = { current: null, at: 0 };
let users = 0;
let listening = false;
let timer: number | undefined;
let seq = Date.now() * 1000;
let sentOn: boolean | null = null;

function sync() {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const want = users > 0;
    if (want === sentOn) return;
    sentOn = want;
    api.setMeters(want, ++seq).catch(() => {
      sentOn = null;
    });
    if (!want) latest.current = null;
  }, 40);
}

function acquire() {
  users += 1;
  if (!listening) {
    listening = true;
    on.meters((m) => {
      if (users > 0) {
        latest.current = m;
        latest.at = performance.now();
      }
    });
  }
  sync();
}

function release() {
  users = Math.max(0, users - 1);
  sync();
}

// Self-heal: re-assert the desired state every few seconds while meters are
// on screen (covers a backend restart during development).
window.setInterval(() => {
  if (users > 0) api.setMeters(true, ++seq).catch(() => {});
}, 3000);

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
