import { useCallback, useState } from "react";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode etc. */
  }
}

/** A record of named pixel sizes, remembered per window across launches. */
export function useSizes<T extends Record<string, number>>(key: string, defaults: T) {
  const [sizes, setSizes] = useState<T>(() => load(key, defaults));

  const set = useCallback(
    (name: keyof T, px: number) => {
      setSizes((prev) => {
        const next = { ...prev, [name]: Math.round(px) };
        save(key, next);
        return next;
      });
    },
    [key],
  );

  const reset = useCallback(() => {
    setSizes(defaults);
    save(key, defaults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [sizes, set, reset] as const;
}

/**
 * Pointer-drag helper. The pointer delta along `axis` (inverted if asked) is
 * added to `start`, clamped, and passed to `apply` on every move.
 */
export function startDrag(
  e: React.PointerEvent,
  start: number,
  apply: (value: number) => void,
  {
    min,
    max,
    invert = false,
    axis = "x",
  }: { min: number; max: number; invert?: boolean; axis?: "x" | "y" },
) {
  e.preventDefault();
  e.stopPropagation();
  const p0 = axis === "x" ? e.clientX : e.clientY;
  const prevCursor = document.body.style.cursor;
  document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
  document.body.style.userSelect = "none";
  const move = (ev: PointerEvent) => {
    const d = ((axis === "x" ? ev.clientX : ev.clientY) - p0) * (invert ? -1 : 1);
    apply(Math.max(min, Math.min(max, start + d)));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.style.cursor = prevCursor;
    document.body.style.userSelect = "";
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/**
 * Thin grab strip on an edge of its positioned parent. Vertical strips sit on
 * the left/right edge; horizontal ones on the top/bottom edge.
 */
export function ResizeHandle({
  onPointerDown,
  onDoubleClick,
  side = "right",
  visible = false,
  className = "",
}: {
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick?: () => void;
  side?: "left" | "right" | "top" | "bottom";
  /** Show a faint divider at rest, not just on hover. */
  visible?: boolean;
  className?: string;
}) {
  const horizontal = side === "top" || side === "bottom";
  const pos = {
    left: "top-0 bottom-0 -left-1 w-2 cursor-col-resize",
    right: "top-0 bottom-0 -right-1 w-2 cursor-col-resize",
    top: "left-0 right-0 -top-1 h-2 cursor-row-resize",
    bottom: "left-0 right-0 -bottom-1 h-2 cursor-row-resize",
  }[side];
  return (
    <div
      role="separator"
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onMouseDown={(e) => e.stopPropagation()}
      className={`group/rh absolute z-10 ${pos} ${className}`}
    >
      <div
        className={
          (horizontal ? "my-auto h-px w-full translate-y-[3.5px] " : "mx-auto h-full w-px ") +
          (visible ? "bg-border " : "bg-transparent ") +
          "transition-colors group-hover/rh:bg-brand group-active/rh:bg-brand"
        }
      />
    </div>
  );
}
