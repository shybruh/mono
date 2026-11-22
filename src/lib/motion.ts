// Page-level transitions. They run as view transitions: the browser
// snapshots the old and new screens and animates the two images on the
// compositor, so even big layout swaps cost one re-layout, not one per frame.

type VT = { finished: Promise<void>; skipTransition: () => void };
type Doc = Document & { startViewTransition?: (cb: () => void) => VT };

let current: VT | null = null;

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Runs `update` with a zoom between the old and new screen.
 * `dir` "in" grows the new screen out of `origin` (a point in the window,
 * defaulting to the centre); "out" shrinks the old one back into it.
 */
export function zoomTransition(update: () => void, dir: "in" | "out", origin?: { x: number; y: number }) {
  const doc = document as Doc;
  if (!doc.startViewTransition || reducedMotion() || document.visibilityState !== "visible") return update();
  const root = document.documentElement;
  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? window.innerHeight / 2;
  root.style.setProperty("--vt-x", `${x}px`);
  root.style.setProperty("--vt-y", `${y}px`);
  current?.skipTransition();
  root.dataset.vt = `zoom-${dir}`;
  const t = doc.startViewTransition(update);
  current = t;
  t.finished.finally(() => {
    if (current === t) {
      delete root.dataset.vt;
      current = null;
    }
  });
}

/** Centre of an element, for zoom origins. */
export function centreOf(el: Element | null | undefined) {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
