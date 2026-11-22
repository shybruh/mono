import { useEffect, useRef, type DependencyList } from "react";
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

/** Canvases that want a redraw when a new meters frame arrives. */
const frameListeners = new Set<() => void>();

export function onMetersFrame(cb: () => void): () => void {
  frameListeners.add(cb);
  return () => frameListeners.delete(cb);
}

/** True while the backend is sending frames (it goes quiet once audio stops). */
export const metersFresh = () => performance.now() - latest.at < 250;

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
      if (users === 0) return;
      latest.current = m;
      latest.at = performance.now();
      for (const cb of frameListeners) cb();
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

export type DrawFn = (ctx: CanvasRenderingContext2D, w: number, h: number, el: HTMLCanvasElement) => boolean | void;

export interface CanvasHandle {
  /** Request frames; keeps animating for at least `ms`. */
  kick: (ms?: number) => void;
}

/**
 * Redraws a canvas only when something changed: when `deps` change, when it
 * is resized, when `kick()` is called, and for as long as `draw` returns true
 * (animations). Nothing runs while the picture is static, so an idle window
 * costs no CPU.
 */
export function useCanvas(
  canvas: React.RefObject<HTMLCanvasElement | null>,
  draw: DrawFn,
  deps: DependencyList,
): CanvasHandle {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const raf = useRef(0);
  const until = useRef(0);

  const handle = useRef<CanvasHandle | null>(null);
  if (!handle.current) {
    const frame = () => {
      raf.current = 0;
      const el = canvas.current;
      let again = false;
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
          again = !!drawRef.current(ctx, w, h, el);
        }
      }
      if (again || performance.now() < until.current) raf.current = requestAnimationFrame(frame);
    };
    handle.current = {
      kick: (ms = 0) => {
        until.current = Math.max(until.current, performance.now() + ms);
        if (!raf.current) raf.current = requestAnimationFrame(frame);
      },
    };
  }
  const h = handle.current;

  useEffect(() => {
    h.kick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver(() => h.kick());
    ro.observe(el);
    // Theme / accent changes cross-fade over ~500 ms; follow them.
    const mo = new MutationObserver(() => h.kick(700));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-glass"] });
    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [canvas, h]);

  return h;
}

/** Meter canvases: draw on every incoming frame, idle when the stream stops. */
export function useMeterCanvas(canvas: React.RefObject<HTMLCanvasElement | null>, draw: DrawFn) {
  const h = useCanvas(canvas, (ctx, w, hgt, el) => {
    draw(ctx, w, hgt, el);
    return false;
  }, []);
  useEffect(() => onMetersFrame(() => h.kick()), [h]);
}
