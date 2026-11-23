import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { ArrowDown, ArrowUp } from "lucide-react";
import { fillMissing, needsInfo, useFill } from "@/lib/fill";
import { analyse, useAnalysis } from "@/lib/analysis";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { COLUMN, COLUMNS, DEFAULT_VISIBLE, type ColId, type ColumnDef } from "@/lib/columns";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { ResizeHandle, startDrag } from "@/hooks/useDragSize";
import { useCompact } from "@/hooks/useCompact";

const ROW = 28;
// Header padding: px-3 + 2 px row accent border + the list's 12 px scrollbar gutter.
const PAD = 12 + 2 + 12 + 12;

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...(fallback as object), ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}
function persist(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

const DEFAULT_WIDTHS = Object.fromEntries(COLUMNS.map((c) => [c.id, c.width])) as Record<ColId, number>;

/** Visible columns (registry order, Time last) and their widths, remembered. */
function useColumns() {
  const [visible, setVisible] = useState<ColId[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem("mono.layout.visible") ?? "null");
      return Array.isArray(v) ? v.filter((id) => id in COLUMN) : DEFAULT_VISIBLE;
    } catch {
      return DEFAULT_VISIBLE;
    }
  });
  const [widths, setWidths] = useState<Record<ColId, number>>(() => load("mono.layout.widths", DEFAULT_WIDTHS));

  const cols = COLUMNS.filter((c) => c.fixed || visible.includes(c.id));
  const toggle = (id: ColId) => {
    const next = visible.includes(id) ? visible.filter((v) => v !== id) : [...visible, id];
    setVisible(next);
    persist("mono.layout.visible", next);
  };
  const setWidth = (id: ColId, w: number) => {
    setWidths((prev) => {
      const next = { ...prev, [id]: Math.round(w) };
      persist("mono.layout.widths", next);
      return next;
    });
  };
  const reset = () => {
    setVisible(DEFAULT_VISIBLE);
    setWidths(DEFAULT_WIDTHS);
    persist("mono.layout.visible", DEFAULT_VISIBLE);
    persist("mono.layout.widths", DEFAULT_WIDTHS);
  };
  return { cols, visible, widths, toggle, setWidth, reset };
}

export function TrackList() {
  const list = useStore((s) => s.list);
  const loading = useStore((s) => s.listLoading);
  const selected = useStore((s) => s.selected);
  const selection = useStore((s) => s.selection);
  const sort = useStore((s) => s.sort);
  const keyNotation = useStore((s) => s.keyNotation);
  const playingPath = useStore((s) => s.track?.meta.path);
  const isPlaying = useStore((s) => s.player.playing);
  const rgMode = useStore((s) => s.config?.rgMode ?? "track");
  const view = useStore((s) => s.view);
  const viewKey = view ? JSON.stringify(view) : "";
  const fill = useFill();
  const analysing = useAnalysis();
  const missing = useMemo(() => list.filter(needsInfo).length, [list]);
  const selSet = useMemo(() => new Set(selection), [selection]);
  const columns = useColumns();
  const { visible, widths, toggle, setWidth, reset } = columns;
  const compact = useCompact();
  // Phones: number, title (taking the room) and time only.
  const cols = compact ? columns.cols.filter((c) => c.id === "num" || c.id === "title" || c.id === "time") : columns.cols;
  const header = useRef<HTMLDivElement>(null);

  // Time (when shown) is pinned right with spare space before it; flexible
  // text columns shrink toward their minimum when the window is narrow.
  const hasTime = cols.some((c) => c.id === "time");
  const track = (c: ColumnDef) =>
    compact && c.id === "title" ? "minmax(0,1fr)" : c.flex ? `minmax(${c.min}px,${widths[c.id]}px)` : `${widths[c.id]}px`;
  const template = {
    gridTemplateColumns: [
      ...cols.filter((c) => c.id !== "time").map(track),
      compact ? "0px" : "minmax(0,1fr)",
      ...(hasTime ? [track(COLUMN.time)] : []),
    ].join(" "),
  };
  const colStart = (c: ColumnDef) => (c.id === "time" ? { gridColumnStart: cols.length + 1 } : undefined);

  const handle = (c: ColumnDef) => (
    <ResizeHandle
      visible
      side={c.id === "time" ? "left" : "right"}
      onPointerDown={(e) => {
        const inner = (header.current?.clientWidth ?? 0) - PAD;
        const others = cols.filter((o) => o.id !== c.id).reduce((sum, o) => sum + widths[o.id], 0);
        const max = Math.max(c.min, Math.min(c.max, inner - others));
        startDrag(e, Math.min(widths[c.id], max), (v) => setWidth(c.id, v), {
          min: c.min,
          max,
          invert: c.id === "time",
        });
      }}
      onDoubleClick={reset}
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

  // Keep the keyboard focus row in view.
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

  const ctx = { rgMode, keyNotation };
  const status = fill.running
    ? { text: `${fill.done}/${fill.total}`, stop: fill.cancel }
    : analysing.running
      ? { text: `BPM ${analysing.done}/${analysing.total}`, stop: analysing.cancel }
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={header}
            className="grid shrink-0 border-l-2 border-transparent py-1.5 pr-6 pl-3 font-mono text-[11px] text-muted-foreground/60 select-none"
            style={template}
          >
            {cols.map((c) => {
              const active = sort?.col === c.id;
              const Arrow = sort?.dir === -1 ? ArrowDown : ArrowUp;
              return (
                <span
                  key={c.id}
                  className={cn("relative min-w-0", c.id !== "num" && c.id !== "title" && "pl-2", c.align === "right" && "pr-2 text-right")}
                  style={colStart(c)}
                >
                  <button
                    onClick={() => useStore.getState().setSort(c.id)}
                    className={cn(
                      "inline-flex max-w-full items-center gap-1 truncate hover:text-foreground",
                      active && "text-foreground",
                    )}
                  >
                    {c.label}
                    {active && <Arrow className="size-3 shrink-0" />}
                  </button>
                  {!compact && handle(c)}
                </span>
              );
            })}
            {status && (
              <button
                title="Stop"
                onClick={status.stop}
                className="flex items-center gap-1.5 justify-self-end pr-3 text-brand hover:text-foreground"
                style={{ gridColumnStart: cols.length + (hasTime ? 0 : 1), gridRowStart: 1 }}
              >
                <span className="size-1.5 animate-pulse rounded-full bg-current" />
                {status.text}
              </button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuLabel className="text-[11px] font-normal text-muted-foreground">Columns</ContextMenuLabel>
          {COLUMNS.filter((c) => !c.fixed).map((c) => (
            <ContextMenuCheckboxItem
              key={c.id}
              checked={visible.includes(c.id)}
              onCheckedChange={() => toggle(c.id)}
              onSelect={(e) => e.preventDefault()}
            >
              {c.label}
            </ContextMenuCheckboxItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuLabel className="text-[11px] font-normal text-muted-foreground">Key notation</ContextMenuLabel>
          <ContextMenuRadioGroup
            value={keyNotation}
            onValueChange={(v) => useStore.getState().setKeyNotation(v as typeof keyNotation)}
          >
            <ContextMenuRadioItem value="musical">Musical (Am)</ContextMenuRadioItem>
            <ContextMenuRadioItem value="camelot">Camelot (8A)</ContextMenuRadioItem>
          </ContextMenuRadioGroup>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={reset}>Reset columns</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            {!loading && list.length > 0 && (
              <div key={viewKey} className="animate-rise" style={{ height: list.length * ROW, position: "relative" }}>
                {list.slice(start, end).map((m, k) => {
                  const i = start + k;
                  const playing = m.path === playingPath;
                  const chosen = selSet.has(m.path);
                  return (
                    <div
                      key={m.path}
                      onMouseDown={(e) => {
                        if (e.button === 0) {
                          useStore.getState().clickRow(i, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
                        } else if (e.button === 2 && !chosen) {
                          useStore.getState().select(i);
                        }
                      }}
                      onDoubleClick={() => useStore.getState().playFromList(i)}
                      // Touch has no double-click: a tap plays.
                      onClick={compact ? () => useStore.getState().playFromList(i) : undefined}
                      className={cn(
                        "absolute inset-x-0 grid cursor-default items-center border-l-2 border-transparent px-3 font-mono text-[12px] select-none",
                        chosen && !playing && "bg-accent/70",
                        playing && "border-brand bg-brand-wash text-brand",
                        playing && chosen && "bg-brand-muted/60",
                        !playing && "text-muted-foreground",
                      )}
                      style={{ ...template, top: i * ROW, height: ROW }}
                    >
                      {cols.map((c) => {
                        if (c.id === "num") {
                          return (
                            <span key="num" className="tabular-nums">
                              {playing && isPlaying ? (
                                <span className="inline-flex h-3 items-end gap-px">
                                  <span className="h-full w-0.5 origin-bottom animate-[eq_0.9s_ease-in-out_infinite] bg-current" />
                                  <span className="h-full w-0.5 origin-bottom animate-[eq_0.7s_ease-in-out_infinite_0.2s] bg-current" />
                                  <span className="h-full w-0.5 origin-bottom animate-[eq_1.1s_ease-in-out_infinite_0.1s] bg-current" />
                                </span>
                              ) : (
                                c.text(m, { ...ctx, index: i })
                              )}
                            </span>
                          );
                        }
                        return (
                          <span
                            key={c.id}
                            className={cn(
                              "truncate pr-3 tabular-nums",
                              c.id !== "title" && "pl-2",
                              c.id === "title" && !playing && "text-foreground",
                              c.align === "right" && "pr-2 text-right",
                            )}
                            style={colStart(c)}
                          >
                            {c.text(m, { ...ctx, index: i })}
                          </span>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <RowMenu
          missing={missing}
          busy={fill.running || analysing.running}
          onSavePlaylist={saveAsPlaylist}
          canRenumber={view?.kind === "crate"}
        />
      </ContextMenu>
    </div>
  );
}

/** Right-click menu for the selected tracks. */
function RowMenu({
  missing,
  busy,
  onSavePlaylist,
  canRenumber,
}: {
  missing: number;
  busy: boolean;
  onSavePlaylist: () => void;
  canRenumber: boolean;
}) {
  const count = useStore((s) => s.selection.length);
  const s = useStore.getState;
  const paths = () => s().selectedTracks().map((m) => m.path);
  const n = count > 1 ? ` (${count})` : "";
  return (
    <ContextMenuContent className="w-60">
      <ContextMenuItem
        disabled={!count}
        onSelect={() => {
          const first = s().list.findIndex((m) => m.path === paths()[0]);
          if (first >= 0) s().playFromList(first);
        }}
      >
        Play
      </ContextMenuItem>
      <ContextMenuItem disabled={!count} onSelect={() => s().playNext(paths())}>
        Play next{n}
      </ContextMenuItem>
      <ContextMenuItem disabled={!count} onSelect={() => s().addToQueue(paths())}>
        Add to queue{n}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!count} onSelect={() => s().openTags(paths())}>
        Edit tags{n}
      </ContextMenuItem>
      <ContextMenuItem disabled={!count || busy} onSelect={() => analyse(s().selectedTracks())}>
        Analyse BPM and key{n}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => s().selectAll()}>Select all</ContextMenuItem>
      {canRenumber && (
        <ContextMenuItem
          onSelect={async () => {
            await api.renumber(s().list.map((t) => t.path));
            s().reloadList();
          }}
        >
          Renumber crate in this order
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={onSavePlaylist}>Save crate as playlist</ContextMenuItem>
      <ContextMenuItem disabled={busy || missing === 0} onSelect={() => fillMissing(s().list)}>
        Fill missing info online{missing ? ` (${missing})` : ""}
      </ContextMenuItem>
      <ContextMenuItem disabled={busy} onSelect={() => analyse(s().list.filter((m) => !m.bpm || !m.key))}>
        Analyse BPM and key for crate
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
