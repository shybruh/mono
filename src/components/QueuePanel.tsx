import { useEffect, useMemo, useState } from "react";
import { GripVertical, X } from "lucide-react";
import { api, type TrackMeta } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { basename, cn, fmtTime } from "@/lib/utils";

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
  dragProps,
  onPlay,
}: {
  path: string;
  meta?: TrackMeta;
  current?: boolean;
  onRemove?: () => void;
  dragProps?: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  onPlay?: () => void;
}) {
  return (
    <div
      {...dragProps}
      onDoubleClick={onPlay}
      className={cn(
        "group flex h-11 items-center gap-2 rounded-md px-2 hover:bg-accent/60",
        current && "bg-brand-wash text-brand hover:bg-brand-wash",
      )}
    >
      {dragProps ? (
        <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground/50" />
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
          className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function QueuePanel() {
  const open = useStore((s) => s.queueOpen);
  const queue = useStore((s) => s.player.queue);
  const index = useStore((s) => s.player.index);
  const userEnd = useStore((s) => s.userQueueEnd);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

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

  return (
    <Sheet open={open} onOpenChange={(v) => useStore.getState().setQueueOpen(v)}>
      <SheetContent className="w-[380px] gap-0 sm:max-w-[380px]">
        <SheetHeader className="border-b">
          <SheetTitle className="text-sm font-medium">Up next</SheetTitle>
          <SheetDescription className="text-[11px]">
            {upcoming.length ? `${upcoming.length} tracks` : "Queue is empty"}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
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
          {upcoming.slice(0, 500).map((p, k) => (
            <div key={`${p}-${k}`} className={cn(over === k && drag != null && "border-t-2 border-brand")}>
              <Row
                path={p}
                meta={meta(p)}
                onRemove={() => remove(k)}
                onPlay={() => api.playIndex(cur + 1 + k)}
                dragProps={{
                  draggable: true,
                  onDragStart: (e) => {
                    setDrag(k);
                    e.dataTransfer.effectAllowed = "move";
                  },
                  onDragOver: (e) => {
                    e.preventDefault();
                    setOver(k);
                  },
                  onDrop: (e) => {
                    e.preventDefault();
                    if (drag != null) move(drag, k);
                    setDrag(null);
                    setOver(null);
                  },
                  onDragEnd: () => {
                    setDrag(null);
                    setOver(null);
                  },
                }}
              />
            </div>
          ))}
          {upcoming.length > 500 && (
            <div className="px-2 py-3 text-[11px] text-muted-foreground">+{upcoming.length - 500} more</div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
