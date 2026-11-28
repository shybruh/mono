import { useEffect, useMemo, useRef, useState } from "react";
import { GripVertical, X } from "lucide-react";
import { api, type TrackMeta } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { basename, cn, fmtTime } from "@/lib/utils";
import { useCompact } from "@/hooks/useCompact";

/** When the last drag ended, so its release doesn't also count as a tap. */
let lastDragEnd = 0;

// Metadata for queue rows, shared across opens. Seeded from the visible list.
const metaCache = new Map<string, TrackMeta>();

function useMetas(paths: string[]) {
  const [, bump] = useState(0);
  useEffect(() => {
    for (const m of useStore.getState().baseList) metaCache.set(m.path, m);
    const missing = [...new Set(paths)].filter((p) => !metaCache.has(p)).slice(0, 200);
    if (!missing.length) return;
    let live = true;
    Promise.all(missing.map((p) => api.trackMeta(p).then((m) => metaCache.set(p, m)).catch(() => {}))).then(
      () => live && bump((n) => n + 1),
    );
    return () => {
      live = false;
    };
  }, [paths]);
  return (p: string) => metaCache.get(p);
}

function Row({
  path,
  meta,
  current,
  onRemove,
  onPointerDown,
  dragging,
  onPlay,
}: {
  path: string;
  meta?: TrackMeta;
  current?: boolean;
  onRemove?: () => void;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  dragging?: boolean;
  onPlay?: () => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={onPlay}
      onClick={(e) => {
        // Phones have no double tap; a tap that wasn't a drag plays the row.
        if (performance.now() - lastDragEnd < 300) return;
        if (onPlay && window.matchMedia("(max-width: 639px)").matches && !(e.target as HTMLElement).closest("button")) onPlay();
      }}
      className={cn(
        "group flex h-11 items-center gap-2 rounded-md px-2 hover:bg-accent/60",
        current && "bg-brand-wash text-brand hover:bg-brand-wash",
        dragging && "bg-accent/60 opacity-50",
      )}
    >
      {onPointerDown ? (
        <span data-grip className="-m-2 flex shrink-0 touch-none p-2">
          <GripVertical className="size-3.5 cursor-grab text-muted-foreground/50" />
        </span>
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[13px]", !current && "text-foreground")}>
          {meta?.title || basename(path)}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">{meta?.artist ?? ""}</span>
      </span>
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
        {meta ? fmtTime(meta.duration) : ""}
      </span>
      {onRemove && (
        <button
          aria-label="Remove"
          onClick={onRemove}
          className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground max-sm:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function QueuePanel() {
  const open = useStore((s) => s.queueOpen);
  const compact = useCompact();
  const queue = useStore((s) => s.player.queue);
  const index = useStore((s) => s.player.index);
  const userEnd = useStore((s) => s.userQueueEnd);
  const [drag, setDrag] = useState<number | null>(null);
  /** Insertion slot (0..upcoming.length) while dragging. */
  const [over, setOver] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const cur = index ?? -1;
  const upcoming = useMemo(() => queue.slice(cur + 1), [queue, cur]);
  const meta = useMetas(open ? queue.slice(Math.max(0, cur), cur + 201) : []);
  const { setQueueOrder } = useStore.getState();

  /** Moves upcoming item `from` to position `to` (both relative to upcoming). */
  const move = (from: number, to: number) => {
    if (from === to || index == null) return;
    const up = upcoming.slice();
    const [item] = up.splice(from, 1);
    up.splice(to, 0, item);
    setQueueOrder([...queue.slice(0, cur + 1), ...up], index);
  };
  const remove = (k: number) => {
    if (index == null) return;
    const up = upcoming.filter((_, i) => i !== k);
    setQueueOrder([...queue.slice(0, cur + 1), ...up], index);
  };
  const userCount = userEnd != null ? Math.max(0, userEnd - (cur + 1)) : 0;

  /**
   * Pointer-driven reordering (no HTML5 drag and drop, which the window's
   * native file drop disables on Windows). Press a row and move a few pixels
   * to pick it up; a line shows where it will land.
   */
  const startDrag = (k: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    // On touch the list scrolls; only the grip picks a row up.
    if (e.pointerType === "touch" && !(e.target as Element).closest("[data-grip]")) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let active = false;
    let slot: number | null = null;
    const slotAt = (y: number): number | null => {
      const rows = scroller.current?.querySelectorAll<HTMLElement>("[data-q]");
      if (!rows?.length) return null;
      for (const el of rows) {
        const r = el.getBoundingClientRect();
        if (y < r.top + r.height / 2) return Number(el.dataset.q);
      }
      return Number(rows[rows.length - 1].dataset.q) + 1;
    };
    const moveH = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        active = true;
        setDrag(k);
        document.body.style.cursor = "grabbing";
      }
      // Scroll when held near the list's top or bottom edge.
      const box = scroller.current?.getBoundingClientRect();
      if (box && scroller.current) {
        if (ev.clientY < box.top + 32) scroller.current.scrollTop -= 12;
        else if (ev.clientY > box.bottom - 32) scroller.current.scrollTop += 12;
      }
      slot = slotAt(ev.clientY);
      setOver(slot);
    };
    const up = () => {
      window.removeEventListener("pointermove", moveH);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
      if (active) lastDragEnd = performance.now();
      if (active && slot != null) move(k, slot > k ? slot - 1 : slot);
      setDrag(null);
      setOver(null);
    };
    window.addEventListener("pointermove", moveH);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const shown = upcoming.slice(0, 500);

  return (
    <Sheet open={open} onOpenChange={(v) => useStore.getState().setQueueOpen(v)}>
      <SheetContent
        side={compact ? "bottom" : "right"}
        className={compact ? "h-[78dvh] gap-0 rounded-t-2xl" : "w-[380px] gap-0 sm:max-w-[380px]"}
      >
        {compact && <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border" />}
        <SheetHeader className="border-b">
          <SheetTitle className="text-sm font-medium">Up next</SheetTitle>
          <SheetDescription className="text-[11px]">
            {upcoming.length ? `${upcoming.length} tracks` : "Queue is empty"}
          </SheetDescription>
        </SheetHeader>
        <div ref={scroller} className={cn("min-h-0 flex-1 overflow-y-auto p-2", drag != null && "select-none")}>
          {index != null && queue[index] && (
            <>
              <div className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground/70">Now playing</div>
              <Row path={queue[index]} meta={meta(queue[index])} current />
            </>
          )}
          {upcoming.length > 0 && (
            <div className="flex items-center justify-between px-2 pt-4 pb-1.5 text-[11px] text-muted-foreground/70">
              <span>{userCount ? `Queued (${userCount}), then` : "Next"}</span>
              <button
                className="hover:text-foreground"
                onClick={() => index != null && setQueueOrder(queue.slice(0, cur + 1), index)}
              >
                Clear
              </button>
            </div>
          )}
          {shown.map((p, k) => {
            const lineAbove = drag != null && over === k && k !== drag && k !== drag + 1;
            const lineBelow =
              drag != null && k === shown.length - 1 && over === shown.length && drag !== shown.length - 1;
            return (
              <div
                key={`${p}-${k}`}
                data-q={k}
                className={cn(
                  "relative",
                  (lineAbove || lineBelow) &&
                    "after:absolute after:inset-x-2 after:h-0.5 after:rounded-full after:bg-brand",
                  lineAbove && "after:-top-px",
                  lineBelow && "after:-bottom-px",
                )}
              >
                <Row
                  path={p}
                  meta={meta(p)}
                  onRemove={() => remove(k)}
                  onPlay={() => api.playIndex(cur + 1 + k)}
                  onPointerDown={startDrag(k)}
                  dragging={drag === k}
                />
              </div>
            );
          })}
          {upcoming.length > 500 && (
            <div className="px-2 py-3 text-[11px] text-muted-foreground">+{upcoming.length - 500} more</div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
