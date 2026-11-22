import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Pause, Pin, PinOff, Play, SkipBack, SkipForward, X } from "lucide-react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { THEMES } from "@/lib/theme";
import { PeakMeter, Scope, Spectrum, fmtDb, useReadout } from "./meters/Meters";
import { fmtTime } from "@/lib/utils";

const DECK_HEIGHT = 64;

const METERS = [
  { id: "spectrum", label: "Spectrum" },
  { id: "scope", label: "Scope" },
  { id: "peak", label: "Peak" },
  { id: "lufs", label: "LUFS" },
  { id: "cover", label: "Cover" },
] as const;

const win = getCurrentWindow();

function Lufs() {
  const v = useReadout((m) => m.lufsS);
  return (
    <div className="w-12 shrink-0 text-right">
      <div className="font-mono text-[15px] leading-none text-(--deck-acc) tabular-nums">{fmtDb(v)}</div>
      <div className="mt-1 font-mono text-[10px] text-(--deck-mut)">LUFS</div>
    </div>
  );
}

function PeakReadout() {
  const v = useReadout((m) => Math.max(m.peakL, m.peakR));
  return <span>{fmtDb(v)}</span>;
}

function Progress() {
  const pos = useStore((s) => s.pos);
  const duration = useStore((s) => s.duration);
  const ref = useRef<HTMLDivElement>(null);
  const f = duration > 0 ? Math.min(1, pos / duration) : 0;
  return (
    <div
      ref={ref}
      className="group/p absolute inset-x-0 bottom-0 h-1.5 cursor-pointer"
      onMouseDown={(e) => {
        e.stopPropagation();
        const r = ref.current!.getBoundingClientRect();
        if (duration > 0) api.seek(((e.clientX - r.left) / r.width) * duration);
      }}
    >
      <div className="absolute inset-x-0 bottom-0 h-0.5 bg-(--deck-track) transition-[height] group-hover/p:h-[5px]">
        <div className="h-full bg-(--deck-acc)" style={{ width: `${f * 100}%` }} />
      </div>
    </div>
  );
}

export function Deck() {
  const config = useStore((s) => s.config);
  const track = useStore((s) => s.track);
  const cover = useStore((s) => s.cover);
  const playing = useStore((s) => s.player.playing);
  const pos = useStore((s) => s.pos);
  const duration = useStore((s) => s.duration);
  const [pinned, setPinned] = useState(true);

  const theme = config?.theme ?? "zinc";
  const meters = new Set(config?.deckMeters ?? ["spectrum", "peak", "lufs", "cover"]);
  const content = useRef<HTMLDivElement>(null);

  // The window hugs its content: it grows and shrinks with the enabled meters.
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    let last = 0;
    const fit = () => {
      const w = Math.ceil(el.getBoundingClientRect().width);
      if (w > 0 && w !== last) {
        last = w;
        win.setSize(new LogicalSize(w, DECK_HEIGHT));
      }
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, []);

  const toggleMeter = (id: string) => {
    const next = new Set(meters);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    useStore.getState().setConfig({ deckMeters: [...next] });
  };

  // Native menu: the deck window is too short to contain an in-page menu.
  const openMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const setCfg = useStore.getState().setConfig;
    const skins = await Submenu.new({
      text: "Theme",
      items: await Promise.all(
        THEMES.map((t) =>
          CheckMenuItem.new({ text: t.label, checked: theme === t.id, action: () => setCfg({ theme: t.id }) }),
        ),
      ),
    });
    const meterItems = await Submenu.new({
      text: "Meters",
      items: await Promise.all(
        METERS.map((m) =>
          CheckMenuItem.new({ text: m.label, checked: meters.has(m.id), action: () => toggleMeter(m.id) }),
        ),
      ),
    });
    const menu = await Menu.new({
      items: [
        skins,
        meterItems,
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({ text: "Back to main window", action: () => api.closeDeck() }),
      ],
    });
    await menu.popup(new LogicalPosition(e.clientX, e.clientY));
  };

  const iconBtn =
    "flex items-center justify-center rounded-md p-1 text-(--deck-fg) hover:bg-(--deck-track) [&_svg]:size-4";

  return (
    <div
      onContextMenu={openMenu}
      className="deck group relative h-screen overflow-hidden bg-(--deck-bg) font-(family-name:--theme-font) text-(--deck-fg)"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest("button")) return;
        win.startDragging();
      }}
    >
        <div ref={content} className="flex h-full w-max items-center gap-3.5 py-2 pr-3 pl-2">
          {meters.has("cover") && (
            <div className="aspect-square h-[calc(100%-4px)] max-h-14 shrink-0 overflow-hidden rounded-md bg-(--deck-track)">
              {cover && <img src={cover} alt="" className="size-full object-cover" draggable={false} />}
            </div>
          )}
          <div className="flex shrink-0 items-center gap-0.5">
            <button aria-label="Previous" className={iconBtn} onClick={() => api.prev()}>
              <SkipBack />
            </button>
            <button
              aria-label={playing ? "Pause" : "Play"}
              onClick={() => api.toggle()}
              className="flex size-[30px] items-center justify-center rounded-full bg-(--deck-acc) text-brand-foreground hover:opacity-85 [&_svg]:size-3.5 [&_svg]:fill-current"
            >
              {playing ? <Pause /> : <Play className="translate-x-px" />}
            </button>
            <button aria-label="Next" className={iconBtn} onClick={() => api.next()}>
              <SkipForward />
            </button>
          </div>
          <div className="w-[200px] min-w-0">
            <div className="truncate text-[12px] font-medium">{track?.meta.title ?? "—"}</div>
            <div className="flex gap-1.5 font-mono text-[11px] text-(--deck-mut)">
              <span className="min-w-0 truncate">{track?.meta.artist ?? ""}</span>
              <span className="ml-auto shrink-0 tabular-nums">
                {fmtTime(pos)} / {fmtTime(duration)}
              </span>
            </div>
          </div>
          {meters.has("spectrum") && <Spectrum className="h-10 w-[150px] shrink-0" />}
          {meters.has("scope") && <Scope className="h-10 w-[70px] shrink-0" />}
          {meters.has("peak") && (
            <div className="flex w-14 shrink-0 flex-col gap-1">
              <PeakMeter className="h-3.5 w-14" />
              <span className="flex justify-between font-mono text-[10px] text-(--deck-mut)">
                <span>L R</span>
                <PeakReadout />
              </span>
            </div>
          )}
          {meters.has("lufs") && <Lufs />}
        </div>

          <div className="absolute top-1 right-1.5 flex gap-0.5 bg-(--deck-bg) pl-1.5 opacity-0 transition-opacity group-hover:opacity-100 [&_svg]:size-3.5!">
            <button
              aria-label={pinned ? "Unpin" : "Pin"}
              className={iconBtn}
              onClick={() => {
                win.setAlwaysOnTop(!pinned);
                setPinned(!pinned);
              }}
            >
              {pinned ? <Pin /> : <PinOff />}
            </button>
            <button aria-label="Expand" className={iconBtn} onClick={() => api.closeDeck()}>
              <Maximize2 />
            </button>
            <button aria-label="Quit" className={iconBtn} onClick={() => api.quit()}>
              <X />
            </button>
          </div>
          <Progress />
    </div>
  );
}
