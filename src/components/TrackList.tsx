import { useEffect, useRef, useState } from "react";
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

const ROW = 28;
const COLS = "grid-cols-[44px_minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_72px_56px]";

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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("grid shrink-0 px-3 py-1.5 font-mono text-[11px] text-muted-foreground/60", COLS)}>
        <span>#</span>
        <span>Title</span>
        <span>Artist</span>
        <span>Album</span>
        <span>Gain</span>
        <span className="text-right">Time</span>
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
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
                        COLS,
                        i === selected && !playing && "bg-accent/70",
                        playing && "border-brand bg-brand-wash text-brand",
                        !playing && "text-muted-foreground",
                      )}
                      style={{ top: i * ROW, height: ROW }}
                    >
                      <span className="tabular-nums">
                        {playing && isPlaying ? (
                          <span className="inline-flex h-3 items-end gap-px">
                            <span className="w-0.5 animate-[eq_0.9s_ease-in-out_infinite] bg-current" />
                            <span className="w-0.5 animate-[eq_0.7s_ease-in-out_infinite_0.2s] bg-current" />
                            <span className="w-0.5 animate-[eq_1.1s_ease-in-out_infinite_0.1s] bg-current" />
                          </span>
                        ) : (
                          String(m.track ?? i + 1).padStart(2, "0")
                        )}
                      </span>
                      <span className={cn("truncate pr-3", !playing && "text-foreground")}>{m.title}</span>
                      <span className="truncate pr-3">{m.artist ?? ""}</span>
                      <span className="truncate pr-3">{m.album ?? ""}</span>
                      <span className="tabular-nums">{gainOf(m, rgMode)}</span>
                      <span className="text-right tabular-nums">{fmtTime(m.duration)}</span>
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
