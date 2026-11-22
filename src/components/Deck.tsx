import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Pause, Pin, PinOff, Play, SkipBack, SkipForward, X } from "lucide-react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
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
import { PeakMeter, Scope, Spectrum, fmtDb, useReadout } from "./meters/Meters";
import { fmtTime } from "@/lib/utils";

export const DECK_SKINS = [
  { id: "zinc", label: "Zinc" },
  { id: "cover", label: "Cover" },
  { id: "phosphor", label: "Phosphor" },
  { id: "amber", label: "Amber" },
] as const;

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

  const skin = config?.deckSkin ?? "zinc";
  const meters = new Set(config?.deckMeters ?? ["spectrum", "peak", "lufs", "cover"]);

  useEffect(() => {
    document.documentElement.dataset.skin = skin;
  }, [skin]);

  const toggleMeter = (id: string) => {
    const next = new Set(meters);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    useStore.getState().setConfig({ deckMeters: [...next] });
  };

  const iconBtn =
    "flex items-center justify-center rounded-md p-1 text-(--deck-fg) hover:bg-(--deck-track) [&_svg]:size-4";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="deck group relative flex h-screen items-center gap-3.5 overflow-hidden bg-(--deck-bg) py-2 pr-3 pl-2 font-(family-name:--deck-font) text-(--deck-fg)"
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            if ((e.target as HTMLElement).closest("button")) return;
            win.startDragging();
          }}
        >
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
              className="flex size-[30px] items-center justify-center rounded-full bg-(--deck-acc) text-(--deck-bg) hover:opacity-85 [&_svg]:size-3.5 [&_svg]:fill-current"
            >
              {playing ? <Pause /> : <Play className="translate-x-px" />}
            </button>
            <button aria-label="Next" className={iconBtn} onClick={() => api.next()}>
              <SkipForward />
            </button>
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium">{track?.meta.title ?? "—"}</div>
            <div className="truncate font-mono text-[11px] text-(--deck-mut)">
              {track?.meta.artist ? `${track.meta.artist} · ` : ""}
              {fmtTime(pos)} / {fmtTime(duration)}
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
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuLabel className="text-[11px] font-normal text-muted-foreground">Skin</ContextMenuLabel>
        <ContextMenuRadioGroup value={skin} onValueChange={(v) => useStore.getState().setConfig({ deckSkin: v })}>
          {DECK_SKINS.map((s) => (
            <ContextMenuRadioItem key={s.id} value={s.id}>
              {s.label}
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>
        <ContextMenuSeparator />
        <ContextMenuLabel className="text-[11px] font-normal text-muted-foreground">Meters</ContextMenuLabel>
        {METERS.map((m) => (
          <ContextMenuCheckboxItem
            key={m.id}
            checked={meters.has(m.id)}
            onCheckedChange={() => toggleMeter(m.id)}
            onSelect={(e) => e.preventDefault()}
          >
            {m.label}
          </ContextMenuCheckboxItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => api.closeDeck()}>Back to main window</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
