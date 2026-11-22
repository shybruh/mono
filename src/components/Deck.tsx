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

const METERS = [
  { id: "spectrum", label: "Spectrum" },
  { id: "scope", label: "Scope" },
  { id: "peak", label: "Peak" },
  { id: "lufs", label: "LUFS" },
  { id: "cover", label: "Cover" },
] as const;

/** Natural width each meter adds, used to grow/shrink the window on toggle. */
const METER_WIDTH: Record<string, number> = { spectrum: 150, scope: 70, peak: 56, lufs: 48 };
const GAP = 14;
const SIZE_KEY = "mono.deck.size";

const win = getCurrentWindow();

function Lufs() {
  const v = useReadout((m) => m.lufsS);
  return (
    <div className="min-w-12 shrink-0 text-right">
      <div className="font-mono text-[clamp(15px,26vh,44px)] leading-none text-(--deck-acc) tabular-nums">
        {fmtDb(v)}
      </div>
      <div className="mt-[0.4em] font-mono text-[clamp(10px,12vh,15px)] text-(--deck-mut)">LUFS</div>
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

  // Restore the last size and remember resizes.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null");
      if (saved?.w && saved?.h) win.setSize(new LogicalSize(saved.w, saved.h));
    } catch {
      /* ignore */
    }
    let t: number | undefined;
    const un = win.onResized(async ({ payload }) => {
      const k = await win.scaleFactor();
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        try {
          localStorage.setItem(SIZE_KEY, JSON.stringify({ w: payload.width / k, h: payload.height / k }));
        } catch {
          /* ignore */
        }
      }, 300);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Turning a meter on or off grows or shrinks the window by its width.
  const toggleMeter = async (id: string) => {
    const next = new Set(meters);
    const adding = !next.has(id);
    if (adding) next.add(id);
    else next.delete(id);
    useStore.getState().setConfig({ deckMeters: [...next] });
    const k = await win.scaleFactor();
    const size = (await win.innerSize()).toLogical(k);
    const extra = (id === "cover" ? size.height - 12 : (METER_WIDTH[id] ?? 0)) + GAP;
    win.setSize(new LogicalSize(Math.max(280, size.width + (adding ? extra : -extra)), size.height));
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
    "flex size-[clamp(26px,40vh,56px)] items-center justify-center rounded-md text-(--deck-fg) hover:bg-(--deck-track) [&_svg]:size-[clamp(15px,25vh,32px)]";

  // Everything is sized from the window height (vh) and shares width with
  // flex, so the deck scales as the window is resized in either direction.
  return (
    <div
      onContextMenu={openMenu}
      className="deck group relative h-screen w-screen overflow-hidden bg-(--deck-bg) font-(family-name:--theme-font) text-(--deck-fg)"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest("button")) return;
        win.startDragging();
      }}
    >
      <div className="flex h-full items-center gap-[clamp(10px,5vh,28px)] py-[clamp(6px,6vh,18px)] pr-[clamp(10px,5vh,24px)] pl-[clamp(6px,4vh,18px)]">
        {meters.has("cover") && (
          <div className="aspect-square h-full shrink-0 overflow-hidden rounded-[clamp(5px,5vh,12px)] bg-(--deck-track)">
            {cover && <img src={cover} alt="" className="size-full object-cover" draggable={false} />}
          </div>
        )}
        <div className="flex shrink-0 items-center gap-[clamp(2px,2vh,8px)]">
          <button aria-label="Previous" className={iconBtn} onClick={() => api.prev()}>
            <SkipBack />
          </button>
          <button
            aria-label={playing ? "Pause" : "Play"}
            onClick={() => api.toggle()}
            className="flex size-[clamp(30px,52vh,80px)] items-center justify-center rounded-full bg-(--deck-acc) text-brand-foreground hover:opacity-85 [&_svg]:size-[clamp(13px,22vh,32px)] [&_svg]:fill-current"
          >
            {playing ? <Pause /> : <Play className="translate-x-px" />}
          </button>
          <button aria-label="Next" className={iconBtn} onClick={() => api.next()}>
            <SkipForward />
          </button>
        </div>
        <div className="max-w-[520px] min-w-[90px] flex-[1_1_200px]">
          <div className="truncate text-[clamp(12px,20vh,28px)] leading-tight font-medium">
            {track?.meta.title ?? "—"}
          </div>
          <div className="mt-[0.15em] flex gap-1.5 font-mono text-[clamp(11px,15vh,19px)] text-(--deck-mut)">
            <span className="min-w-0 truncate">{track?.meta.artist ?? ""}</span>
            <span className="ml-auto shrink-0 tabular-nums">
              {fmtTime(pos)} / {fmtTime(duration)}
            </span>
          </div>
        </div>
        {meters.has("spectrum") && <Spectrum className="h-[64vh] min-w-[70px] flex-[2_1_150px]" />}
        {meters.has("scope") && <Scope className="h-[64vh] min-w-[50px] flex-[1_1_70px]" />}
        {meters.has("peak") && (
          <div className="flex w-[clamp(56px,30vh,130px)] shrink-0 flex-col gap-[0.4em] text-[clamp(10px,12vh,15px)]">
            <PeakMeter className="h-[clamp(14px,24vh,56px)] w-full" />
            <span className="flex justify-between font-mono text-(--deck-mut)">
              <span>L R</span>
              <PeakReadout />
            </span>
          </div>
        )}
        {meters.has("lufs") && <Lufs />}
      </div>

          <div className="absolute top-1 right-1.5 flex gap-0.5 rounded-md bg-(--deck-bg) pl-1.5 opacity-0 transition-opacity group-hover:opacity-100 [&_button]:size-6! [&_svg]:size-3.5!">
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
