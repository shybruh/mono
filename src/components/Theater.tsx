import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Lyrics } from "@/lib/api";
import { useStore } from "@/lib/store";
import { loadLyrics } from "@/lib/lrclib";
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

function LyricsPane({ lyrics }: { lyrics: Lyrics }) {
  const pos = useStore((s) => s.pos);
  const scroller = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const userScrollAt = useRef(0);
  // Lead slightly so the highlight lands with the vocal, not after it.
  const idx = lyrics.synced ? activeLine(lyrics, pos + 0.25) : -1;

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
              onClick={() => l.time != null && api.seek(l.time)}
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

export function Theater() {
  const track = useStore((s) => s.track);
  const cover = useStore((s) => s.cover);
  const online = useStore((s) => s.config?.lyricsOnline ?? false);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const path = track?.meta.path;

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
    <div className="relative flex min-h-0 flex-1 overflow-hidden animate-in fade-in duration-300">
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
            <LyricsPane lyrics={lyrics!} />
          </div>
        )}
      </div>
    </div>
  );
}
