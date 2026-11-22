import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Lyrics } from "@/lib/api";
import { useStore } from "@/lib/store";
import { chooseVersion, getOffset, loadLyrics, setOffset, versions, type Version } from "@/lib/lrclib";
import { ListMusic, Loader2, Maximize, Minimize, Minus, Plus, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, fmtTime } from "@/lib/utils";

/** Index of the last synced line at or before `t`. */
function activeLine(lyrics: Lyrics, t: number): number {
  let lo = 0;
  let hi = lyrics.lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((lyrics.lines[mid].time ?? 0) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function LyricsPane({ lyrics, offset }: { lyrics: Lyrics; offset: number }) {
  const pos = useStore((s) => Math.round(s.pos * 10) / 10);
  const scroller = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const userScrollAt = useRef(0);
  // Lead slightly so the highlight lands with the vocal, not after it.
  // Positive offset = lyrics later.
  const idx = lyrics.synced ? activeLine(lyrics, pos + 0.25 - offset) : -1;

  useEffect(() => {
    if (!lyrics.synced || idx < 0) return;
    if (performance.now() - userScrollAt.current < 3500) return;
    lineRefs.current[idx]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [idx, lyrics.synced]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    lineRefs.current = [];
  }, [lyrics]);

  return (
    <div
      ref={scroller}
      onWheel={() => (userScrollAt.current = performance.now())}
      className="h-full overflow-y-auto pr-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{
        maskImage: "linear-gradient(transparent, black 14%, black 86%, transparent)",
        WebkitMaskImage: "linear-gradient(transparent, black 14%, black 86%, transparent)",
      }}
    >
      <div className={cn("space-y-1", lyrics.synced ? "py-[38vh]" : "py-[10vh]")}>
        {lyrics.lines.map((l, i) => {
          if (!lyrics.synced) {
            return (
              <div key={i} className="min-h-6 text-xl leading-relaxed font-medium text-foreground/80">
                {l.text}
              </div>
            );
          }
          const state = i === idx ? "now" : i < idx ? "past" : "next";
          return (
            <div
              key={i}
              ref={(el) => {
                lineRefs.current[i] = el;
              }}
              onClick={() => l.time != null && api.seek(Math.max(0, l.time + offset))}
              className={cn(
                "origin-left cursor-pointer py-1.5 text-[clamp(20px,2.3vw,32px)] leading-snug font-semibold tracking-tight transition-[color,opacity,transform] duration-300",
                state === "now" && "scale-[1.02] text-foreground",
                state === "past" && "text-foreground/30 hover:text-foreground/60",
                state === "next" && "text-foreground/50 hover:text-foreground/80",
              )}
            >
              {l.text || <span className="text-brand">♪</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function fmtDur(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

function VersionsPicker({
  onPick,
  onOpenChange,
}: {
  onPick: (l: Lyrics | null) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const track = useStore((s) => s.track);
  const [open, setOpenState] = useState(false);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange(v);
  };
  const [list, setList] = useState<Version[] | null>(null);
  const m = track?.meta;

  useEffect(() => {
    if (!open || !m) return;
    setList(null);
    versions(m.artist ?? "", m.title, m.duration)
      .then(setList)
      .catch(() => setList([]));
  }, [open, m?.path]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className={ctl} title="Lyric versions">
          <ListMusic />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[60vh] w-[420px] overflow-y-auto p-1">
        {!list && (
          <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Searching LRCLIB
          </div>
        )}
        {list && list.length === 0 && <div className="px-3 py-3 text-[12px] text-muted-foreground">No versions</div>}
        {list?.map((v) => (
          <button
            key={v.id}
            onClick={async () => {
              setOpen(false);
              if (m) onPick(await chooseVersion(m.path, v));
            }}
            className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-accent"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-foreground">{v.artist}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{v.album || v.title}</span>
            </span>
            <span className="shrink-0 text-right font-mono text-[11px] leading-tight tabular-nums">
              <span className={cn(v.diff <= 2 ? "text-brand" : "text-muted-foreground")}>{fmtDur(v.duration)}</span>
              <br />
              <span className="text-muted-foreground/70">{v.synced ? "timed" : "plain"}</span>
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

const ctl =
  "flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5";

/** Thin status line for fullscreen: elapsed · bar · total, click to seek. */
function MiniSeek() {
  const pos = useStore((s) => Math.floor(s.pos * 2) / 2);
  const duration = useStore((s) => s.duration);
  const bar = useRef<HTMLDivElement>(null);
  const f = duration > 0 ? Math.min(1, pos / duration) : 0;
  return (
    <div className="absolute inset-x-[6vw] bottom-[3.5vh] flex items-center gap-4 font-mono text-[12px] text-muted-foreground tabular-nums">
      <span className="w-12 text-right">{fmtTime(pos)}</span>
      <div
        ref={bar}
        className="group/seek relative h-4 flex-1 cursor-pointer"
        onPointerDown={(e) => {
          const r = bar.current!.getBoundingClientRect();
          if (duration > 0) api.seek(((e.clientX - r.left) / r.width) * duration);
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-foreground/15 transition-[height] group-hover/seek:h-[5px]">
          <div className="h-full rounded-full bg-brand" style={{ width: `${f * 100}%` }} />
        </div>
      </div>
      <span className="w-12">{fmtTime(duration)}</span>
    </div>
  );
}

/** True after `ms` without pointer movement; used to hide the cursor. */
function useIdle(active: boolean, ms = 2500) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!active) return setIdle(false);
    let t = window.setTimeout(() => setIdle(true), ms);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(t);
      t = window.setTimeout(() => setIdle(true), ms);
    };
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [active, ms]);
  return idle;
}

export function Theater({ fullscreen = false }: { fullscreen?: boolean }) {
  const idle = useIdle(fullscreen);
  const track = useStore((s) => s.track);
  const cover = useStore((s) => s.cover);
  const online = useStore((s) => s.config?.lyricsOnline ?? false);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const path = track?.meta.path;
  const [offset, setOffsetState] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    setOffsetState(path ? getOffset(path) : 0);
  }, [path]);

  const nudge = (v: number) => {
    if (!path) return;
    const next = Math.round(v * 100) / 100;
    setOffset(path, next);
    setOffsetState(next);
  };

  useEffect(() => {
    setLyrics(null);
    if (!path) return;
    let live = true;
    loadLyrics(path)
      .then((l) => live && setLyrics(l))
      .catch(() => live && setLyrics(null));
    return () => {
      live = false;
    };
  }, [path, online]);

  const m = track?.meta;
  const sub = useMemo(
    () => (m ? [m.album, m.year].filter(Boolean).join(" · ") : ""),
    [m],
  );
  const hasLyrics = !!lyrics && lyrics.lines.length > 0;

  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 overflow-hidden animate-in fade-in duration-300",
        fullscreen && idle && "cursor-none",
      )}
    >
      {cover && (
        <img
          src={cover}
          alt=""
          aria-hidden
          draggable={false}
          className="pointer-events-none absolute inset-0 size-full scale-125 object-cover opacity-30 blur-3xl saturate-150"
        />
      )}
      <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-background/50 via-background/75 to-background" />

      <div
        className={cn(
          "relative flex min-h-0 flex-1 items-center gap-[5vw] px-[6vw]",
          fullscreen ? "pt-[6vh] pb-[11vh]" : "py-8",
          !hasLyrics && "justify-center",
        )}
      >
        <div className={cn("flex shrink-0 flex-col", !hasLyrics && "items-center text-center")}>
          <div
            className="aspect-square overflow-hidden rounded-xl bg-brand-wash shadow-2xl shadow-black/50"
            style={{
              width: fullscreen
                ? hasLyrics
                  ? "min(60vh, 36vw)"
                  : "min(66vh, 56vw)"
                : hasLyrics
                  ? "min(52vh, 34vw)"
                  : "min(58vh, 50vw)",
            }}
          >
            {cover && <img src={cover} alt="" className="size-full object-cover" draggable={false} />}
          </div>
          {m && (
            <div className="mt-6 max-w-[min(58vh,50vw)] min-w-0">
              <div className="truncate text-[clamp(22px,2.4vw,34px)] leading-tight font-semibold tracking-tight">
                {m.title}
              </div>
              {m.artist && <div className="mt-1 truncate text-lg text-muted-foreground">{m.artist}</div>}
              {sub && <div className="mt-0.5 truncate text-sm text-muted-foreground/70">{sub}</div>}
            </div>
          )}
        </div>
        {hasLyrics && (
          <div className="h-full min-w-0 flex-1">
            <LyricsPane lyrics={lyrics!} offset={offset} />
          </div>
        )}
      </div>

      {/* Hidden until the pointer reaches this corner (generous hit area);
          stays up while the versions list is open. */}
      <div className="group/ctl absolute top-0 right-0 p-3 pl-10 pb-8">
      <div
        className={cn(
          "flex items-center gap-0.5 rounded-lg bg-background/60 p-0.5 opacity-0 backdrop-blur transition-opacity duration-200 group-hover/ctl:opacity-100",
          pickerOpen && "opacity-100",
        )}
      >
        {hasLyrics && lyrics!.synced && (
          <>
            <button className={ctl} title="Lyrics earlier" onClick={() => nudge(offset - 0.25)}>
              <Minus />
            </button>
            <button className={cn(ctl, "w-14 tabular-nums")} title="Reset timing" onClick={() => nudge(0)}>
              {offset > 0 ? "+" : offset < 0 ? "−" : "±"}
              {Math.abs(offset).toFixed(2)}s
            </button>
            <button className={ctl} title="Lyrics later" onClick={() => nudge(offset + 0.25)}>
              <Plus />
            </button>
          </>
        )}
        {online && m && <VersionsPicker onPick={setLyrics} onOpenChange={setPickerOpen} />}
        <button
          className={ctl}
          title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen (F11)"}
          onClick={() => useStore.getState().toggleFullscreen()}
        >
          {fullscreen ? <Minimize /> : <Maximize />}
        </button>
        {fullscreen && (
          <button className={ctl} title="Close" onClick={() => useStore.getState().toggleTheater(false)}>
            <X />
          </button>
        )}
      </div>
      </div>
      {fullscreen && <MiniSeek />}
    </div>
  );
}
