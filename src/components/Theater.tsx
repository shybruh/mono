import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Lyrics } from "@/lib/api";
import { useStore } from "@/lib/store";
import { chooseVersion, getOffset, loadLyrics, setOffset, versions, type Version } from "@/lib/lrclib";
import { ListMusic, Loader2, Minus, Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

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
  const pos = useStore((s) => s.pos);
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

function VersionsPicker({ onPick }: { onPick: (l: Lyrics | null) => void }) {
  const track = useStore((s) => s.track);
  const [open, setOpen] = useState(false);
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

export function Theater() {
  const track = useStore((s) => s.track);
  const cover = useStore((s) => s.cover);
  const online = useStore((s) => s.config?.lyricsOnline ?? false);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const path = track?.meta.path;
  const [offset, setOffsetState] = useState(0);

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
    <div className="group/theater relative flex min-h-0 flex-1 overflow-hidden animate-in fade-in duration-300">
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
          "relative flex min-h-0 flex-1 items-center gap-[5vw] px-[6vw] py-8",
          !hasLyrics && "justify-center",
        )}
      >
        <div className={cn("flex shrink-0 flex-col", !hasLyrics && "items-center text-center")}>
          <div
            className="aspect-square overflow-hidden rounded-xl bg-brand-wash shadow-2xl shadow-black/50"
            style={{ width: hasLyrics ? "min(52vh, 34vw)" : "min(58vh, 50vw)" }}
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

      <div className="absolute top-3 right-4 flex items-center gap-0.5 rounded-lg bg-background/60 p-0.5 opacity-0 backdrop-blur transition-opacity group-hover/theater:opacity-100 focus-within:opacity-100">
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
        {online && m && <VersionsPicker onPick={setLyrics} />}
      </div>
    </div>
  );
}
