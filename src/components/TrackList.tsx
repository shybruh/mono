import { useEffect, useMemo, useRef, useState } from "react";
import { fillMissing, needsInfo, useFill } from "@/lib/fill";
import { save } from "@tauri-apps/plugin-dialog";
import { api, type TrackMeta } from "@/lib/api";
import { useStore } from "@/lib/store";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn, fmtTime } from "@/lib/utils";
import { ResizeHandle, startDrag, useSizes } from "@/hooks/useDragSize";

const ROW = 28;
const DEFAULT_COLS = { num: 44, title: 340, artist: 200, album: 200, gain: 76, time: 60 };
const LIMITS: Record<keyof typeof DEFAULT_COLS, [number, number]> = {
  num: [28, 90],
  title: [120, 1200],
  artist: [60, 800],
  album: [60, 800],
  gain: [48, 160],
  time: [44, 160],
};
// Header padding: px-3 + 2 px row accent border + the list's 12 px scrollbar gutter.
const PAD = 12 + 2 + 12 + 12;
type Col = keyof typeof DEFAULT_COLS;

function gainOf(m: TrackMeta, mode: string) {
  const g = mode === "album" ? (m.rgAlbumGain ?? m.rgTrackGain) : (m.rgTrackGain ?? m.rgAlbumGain);
  if (g == null || mode === "off") return "—";
  return `${g < 0 ? "−" : "+"}${Math.abs(g).toFixed(1)} dB`;
}

export function TrackList() {
  const list = useStore((s) => s.list);
  const loading = useStore((s) => s.listLoading);
  const selected = useStore((s) => s.selected);
  const playingPath = useStore((s) => s.track?.meta.path);
  const isPlaying = useStore((s) => s.player.playing);
  const rgMode = useStore((s) => s.config?.rgMode ?? "track");
  const view = useStore((s) => s.view);
  const fill = useFill();
  const missing = useMemo(() => list.filter(needsInfo).length, [list]);
  const [cols, setCol, resetCols] = useSizes("mono.layout.columns", DEFAULT_COLS);
  const header = useRef<HTMLDivElement>(null);
  // Columns never overflow: Time is pinned to the right edge, spare space sits
  // just before it, and Title / Artist / Album shrink toward their minimums
  // when the window is too narrow (grid minmax tracks).
  const template = {
    gridTemplateColumns: [
      `${cols.num}px`,
      `minmax(${LIMITS.title[0]}px,${cols.title}px)`,
      `minmax(${LIMITS.artist[0]}px,${cols.artist}px)`,
      `minmax(${LIMITS.album[0]}px,${cols.album}px)`,
      `${cols.gain}px`,
      "minmax(0,1fr)",
      `${cols.time}px`,
    ].join(" "),
  };
  // A drag can only use the room that is actually free in the row.
  const handle = (name: Col, side: "left" | "right" = "right") => (
    <ResizeHandle
      visible
      side={side}
      onPointerDown={(e) => {
        const inner = (header.current?.clientWidth ?? 0) - PAD;
        const others = (Object.keys(cols) as Col[])
          .filter((k) => k !== name)
          .reduce((sum, k) => sum + cols[k], 0);
        const max = Math.max(LIMITS[name][0], Math.min(LIMITS[name][1], inner - others));
        startDrag(e, Math.min(cols[name], max), (v) => setCol(name, v), {
          min: LIMITS[name][0],
          max,
          invert: side === "left",
        });
      }}
      onDoubleClick={resetCols}
    />
  );

  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [view]);

  // Keep the keyboard selection in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el || selected == null) return;
    const top = selected * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  }, [selected]);

  const start = Math.max(0, Math.floor(scrollTop / ROW) - 10);
  const end = Math.min(list.length, Math.ceil((scrollTop + height) / ROW) + 10);

  const saveAsPlaylist = async () => {
    const path = await save({
      filters: [{ name: "Playlist", extensions: ["m3u8"] }],
      defaultPath: `${view?.name ?? "playlist"}.m3u8`,
    });
    if (path) {
      await api.savePlaylist(path, list.map((m) => m.path));
      useStore.getState().refreshCrates();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={header}
        className="grid shrink-0 border-l-2 border-transparent py-1.5 pr-6 pl-3 font-mono text-[11px] text-muted-foreground/60 select-none"
        style={template}
      >
        <span className="relative">#{handle("num")}</span>
        <span className="relative">Title{handle("title")}</span>
        <span className="relative pl-2">Artist{handle("artist")}</span>
        <span className="relative pl-2">Album{handle("album")}</span>
        <span className="relative pl-2">Gain{handle("gain")}</span>
        {fill.running && (
          <button
            title="Stop"
            onClick={fill.cancel}
            className="col-start-6 flex items-center gap-1.5 justify-self-end pr-3 text-brand hover:text-foreground"
          >
            <span className="size-1.5 animate-pulse rounded-full bg-current" />
            {fill.done}/{fill.total}
          </button>
        )}
        <span className="relative col-start-7 pr-2 text-right">
          {handle("time", "left")}
          Time
        </span>
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {!loading && list.length > 0 && (
          <div style={{ height: list.length * ROW, position: "relative" }}>
            {list.slice(start, end).map((m, k) => {
              const i = start + k;
              const playing = m.path === playingPath;
              return (
                <ContextMenu key={m.path}>
                  <ContextMenuTrigger asChild>
                    <div
                      onMouseDown={() => useStore.getState().select(i)}
                      onDoubleClick={() => useStore.getState().playFromList(i)}
                      className={cn(
                        "absolute inset-x-0 grid cursor-default items-center border-l-2 border-transparent px-3 font-mono text-[12px]",
                        i === selected && !playing && "bg-accent/70",
                        playing && "border-brand bg-brand-wash text-brand",
                        !playing && "text-muted-foreground",
                      )}
                      style={{ ...template, top: i * ROW, height: ROW }}
                    >
                      <span className="tabular-nums">
                        {playing && isPlaying ? (
                          <span className="inline-flex h-3 items-end gap-px">
                            <span className="h-full w-0.5 origin-bottom animate-[eq_0.9s_ease-in-out_infinite] bg-current" />
                            <span className="h-full w-0.5 origin-bottom animate-[eq_0.7s_ease-in-out_infinite_0.2s] bg-current" />
                            <span className="h-full w-0.5 origin-bottom animate-[eq_1.1s_ease-in-out_infinite_0.1s] bg-current" />
                          </span>
                        ) : (
                          String(m.track ?? i + 1).padStart(2, "0")
                        )}
                      </span>
                      <span className={cn("truncate pr-3", !playing && "text-foreground")}>{m.title}</span>
                      <span className="truncate pr-3 pl-2">{m.artist ?? ""}</span>
                      <span className="truncate pr-3 pl-2">{m.album ?? ""}</span>
                      <span className="truncate pl-2 tabular-nums">{gainOf(m, rgMode)}</span>
                      <span className="col-start-7 pr-2 text-right tabular-nums">{fmtTime(m.duration)}</span>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => useStore.getState().playFromList(i)}>Play</ContextMenuItem>
                    <ContextMenuItem onSelect={() => useStore.getState().openTags(m.path)}>Edit tags</ContextMenuItem>
                    <ContextMenuSeparator />
                    {view?.kind === "crate" && (
                      <ContextMenuItem
                        onSelect={async () => {
                          await api.renumber(list.map((t) => t.path));
                          useStore.getState().reloadList();
                        }}
                      >
                        Renumber crate in this order
                      </ContextMenuItem>
                    )}
                    <ContextMenuItem onSelect={saveAsPlaylist}>Save crate as playlist</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      disabled={fill.running || missing === 0}
                      onSelect={() => fillMissing(list)}
                    >
                      Fill missing info online{missing ? ` (${missing})` : ""}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
