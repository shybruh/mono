import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  AudioWaveform,
  ChevronDown,
  ChevronLeft,
  Folder,
  FolderPlus,
  History,
  LayoutGrid,
  ListFilter,
  ListOrdered,
  MicVocal,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Rows3,
  Search,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersVertical,
} from "lucide-react";
import { api, type CrateNode, type Lyrics } from "@/lib/api";
import { EMPTY, useStore, viewKey, type View } from "@/lib/store";
import { loadLyrics, getOffset } from "@/lib/lrclib";
import { basename, cn } from "@/lib/utils";
import { SeekBar } from "./SeekBar";
import { Chip } from "./NowPlaying";
import { activeLine, LyricsPane } from "./Theater";
import { TrackList } from "./TrackList";
import { addFolder } from "./Sidebar";
import { PeakMeter, Spectrum } from "./meters/Meters";

const AlbumGrid = lazy(() => import("./AlbumGrid").then((m) => ({ default: m.AlbumGrid })));

/**
 * Phone layout. The player is the home screen; crates open over it with a
 * mini player along the bottom, and Up next, lyrics and the equaliser come
 * up as sheets. Only used below 640 px, which the desktop window can't reach.
 */
export function MobileApp() {
  const hasTrack = useStore((s) => !!s.track);
  // Until a screen is picked, the player shows as soon as there's a track
  // (the last one resumes a moment after launch).
  const [picked, setScreen] = useState<"player" | "crates" | null>(null);
  const screen = picked ?? (hasTrack ? "player" : "crates");
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsOn, setLyricsOn] = useState(() => {
    try {
      return localStorage.getItem("mono.mobile.lyrics") === "1";
    } catch {
      return false;
    }
  });
  const toggleLyrics = () => {
    const next = !lyricsOn;
    setLyricsOn(next);
    try {
      localStorage.setItem("mono.mobile.lyrics", next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  const lyrics = useTrackLyrics(lyricsOn || lyricsOpen);

  // The Android app fires this once the user lets it read their music:
  // scan the folders again and show what's there.
  useEffect(() => {
    const onAccess = async () => {
      await api.rescan();
      const s = useStore.getState();
      await s.refreshCrates();
      const first = useStore.getState().crates[0];
      if (first && !s.view) s.openView({ kind: "crate", path: first.path, name: first.name });
    };
    window.addEventListener("mono:storage", onAccess);
    return () => window.removeEventListener("mono:storage", onAccess);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]">
      {screen === "player" && hasTrack ? (
        <PlayerScreen
          onCrates={() => setScreen("crates")}
          lyrics={lyricsOn ? lyrics : false}
          onToggleLyrics={toggleLyrics}
          onOpenLyrics={() => setLyricsOpen(true)}
        />
      ) : (
        <CratesScreen onPlayer={() => setScreen("player")} />
      )}
      {lyricsOpen && hasTrack && <LyricsTheater lyrics={lyrics} onClose={() => setLyricsOpen(false)} />}
    </div>
  );
}

/* ----------------------------------------------------------------- player */

function useSource() {
  return useStore((s) => {
    const m = s.track?.meta;
    if (!m) return s.view?.name ?? "";
    if (s.queueKey?.startsWith("history:")) return s.queueKey === "history:7" ? "Last 7 days" : "Last 30 days";
    return m.path.split(/[\\/]/).slice(-2, -1)[0] ?? "";
  });
}

/** Swipes on the cover: sideways skips, down goes to crates, a tap opens lyrics. */
function useCoverGestures(onDown: () => void, onTap: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      start.current = { x: e.clientX, y: e.clientY };
    },
    onPointerUp: (e: React.PointerEvent) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) api.next();
        else api.prev();
      } else if (dy > 70) onDown();
      else if (Math.hypot(dx, dy) < 8) onTap();
    },
    onPointerCancel: () => {
      start.current = null;
    },
  };
}

function PlayerScreen({
  onCrates,
  lyrics,
  onToggleLyrics,
  onOpenLyrics,
}: {
  onCrates: () => void;
  /** Lyrics shown inline: `false` when that's off, `undefined` while loading. */
  lyrics: Lyrics | null | undefined | false;
  onToggleLyrics: () => void;
  onOpenLyrics: () => void;
}) {
  const track = useStore((s) => s.track);
  const cover = useStore((s) => s.cover);
  const playing = useStore((s) => s.player.playing);
  const repeat = useStore((s) => s.player.repeat);
  const shuffle = useStore((s) => s.shuffle);
  const vizOpen = useStore((s) => s.config?.vizOpen ?? false);
  const eqOn = useStore((s) => !!s.config?.eq.enabled && (s.config.eq.bands.some((b) => b.enabled) || s.config.eq.preamp !== 0));
  const source = useSource();
  const gestures = useCoverGestures(onCrates, onOpenLyrics);
  const m = track?.meta;
  const khz = m?.sampleRate ? `${(m.sampleRate / 1000).toFixed(m.sampleRate % 1000 ? 1 : 0)} kHz` : null;
  const st = useStore.getState;

  return (
    <div className="flex min-h-0 flex-1 animate-in flex-col px-5 pt-2 pb-2 fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex h-11 shrink-0 items-center gap-2">
        <button aria-label="Crates" onClick={onCrates} className="-ml-2 rounded-md p-2 text-muted-foreground [&_svg]:size-5">
          <ChevronDown />
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-xs text-brand">{source}</div>
        <button aria-label="Search" onClick={() => st().setPalette(true)} className="rounded-md p-2 text-muted-foreground [&_svg]:size-[18px]">
          <Search />
        </button>
        <button aria-label="Settings" onClick={() => st().setSettings(true)} className="-mr-2 rounded-md p-2 text-muted-foreground [&_svg]:size-[18px]">
          <Settings />
        </button>
      </div>

      {/* The cover takes whatever height is left, as the largest square that fits. */}
      <div className="flex min-h-0 flex-1 items-center justify-center py-3" style={{ containerType: "size" }}>
        <div
          {...gestures}
          className="aspect-square touch-none overflow-hidden rounded-2xl bg-brand-wash select-none"
          style={{ width: "min(100cqw, 100cqh)" }}
        >
          {cover && <img key={cover} src={cover} alt="" draggable={false} className="size-full animate-fade object-cover" />}
        </div>
      </div>

      <div key={m?.path} className="shrink-0 animate-rise">
        <div className="truncate text-xl leading-tight font-semibold tracking-tight">{m?.title}</div>
        <div className="mt-0.5 truncate text-sm text-muted-foreground">
          {m ? [m.artist, m.album].filter(Boolean).join(" — ") || basename(m.path) : ""}
        </div>
        {m && (
          <div className="mt-2 flex gap-1.5 overflow-hidden">
            {m.bitrate ? <Chip>{m.bitrate} kbps</Chip> : null}
            {khz && <Chip>{khz}</Chip>}
            {m.bitDepth ? <Chip>{m.bitDepth}-bit</Chip> : null}
            <Chip muted>{m.format}</Chip>
          </div>
        )}
      </div>

      {lyrics !== false && <LyricsStrip lyrics={lyrics} onOpen={onOpenLyrics} />}

      {vizOpen && (
        <div className="mt-3 flex h-16 shrink-0 gap-2 animate-in fade-in duration-200">
          <Spectrum className="h-full min-w-0 flex-1" />
          <PeakMeter vertical className="h-full w-3" />
        </div>
      )}

      <div className="mt-3 shrink-0">
        <SeekBar stacked />
      </div>

      <div className="mt-1 flex shrink-0 items-center justify-between px-1">
        <button
          aria-label="Shuffle"
          onClick={() => st().toggleShuffle()}
          className={cn("p-2 text-muted-foreground [&_svg]:size-5", shuffle && "text-brand")}
        >
          <Shuffle />
        </button>
        <button aria-label="Previous" onClick={() => api.prev()} className="p-2 [&_svg]:size-7 [&_svg]:fill-current">
          <SkipBack />
        </button>
        <button
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => api.toggle()}
          className="relative flex size-16 items-center justify-center rounded-full bg-brand text-brand-foreground transition-transform active:scale-95 [&_svg]:absolute [&_svg]:size-7 [&_svg]:fill-current [&_svg]:transition-[opacity,scale,rotate] [&_svg]:duration-200 [&_svg]:ease-[var(--ease-spring)]"
        >
          <Pause className={cn(playing ? "scale-100 rotate-0 opacity-100" : "scale-50 -rotate-90 opacity-0")} />
          <Play className={cn("translate-x-0.5", playing ? "scale-50 rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100")} />
        </button>
        <button aria-label="Next" onClick={() => api.next()} className="p-2 [&_svg]:size-7 [&_svg]:fill-current">
          <SkipForward />
        </button>
        <button
          aria-label={`Repeat ${repeat}`}
          onClick={() => st().cycleRepeat()}
          className={cn("p-2 text-muted-foreground [&_svg]:size-5", repeat !== "off" && "text-brand")}
        >
          {repeat === "one" ? <Repeat1 /> : <Repeat />}
        </button>
      </div>

      <div className="mt-2 flex shrink-0 items-center justify-around border-t pt-2 text-muted-foreground [&_button]:rounded-md [&_button]:p-2.5 [&_svg]:size-5">
        <button aria-label="Lyrics" onClick={onToggleLyrics} className={cn(lyrics !== false && "text-brand")}>
          <MicVocal />
        </button>
        <button aria-label="Up next" onClick={() => st().setQueueOpen(true)}>
          <ListOrdered />
        </button>
        <button aria-label="Equaliser" onClick={() => st().setEqOpen(true)} className={cn(eqOn && "text-brand")}>
          <SlidersVertical />
        </button>
        <button aria-label="Meters" onClick={() => st().toggleViz()} className={cn(vizOpen && "text-brand")}>
          <AudioWaveform />
        </button>
        <button aria-label="Crates" onClick={onCrates}>
          <Folder />
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- lyrics */

/** Lyrics for the current track, loaded only while `enabled`. `undefined` while loading. */
function useTrackLyrics(enabled: boolean) {
  const path = useStore((s) => s.track?.meta.path);
  const online = useStore((s) => s.config?.lyricsOnline ?? false);
  const [lyrics, setLyrics] = useState<Lyrics | null | undefined>(undefined);
  useEffect(() => {
    setLyrics(undefined);
    if (!path || !enabled) return;
    let live = true;
    loadLyrics(path)
      .then((l) => live && setLyrics(l && l.lines.length ? l : null))
      .catch(() => live && setLyrics(null));
    return () => {
      live = false;
    };
  }, [path, online, enabled]);
  return lyrics;
}

/** Three lines around the one being sung, between the track info and the waveform. */
function LyricsStrip({ lyrics, onOpen }: { lyrics: Lyrics | null | undefined; onOpen: () => void }) {
  const path = useStore((s) => s.track?.meta.path);
  const pos = useStore((s) => Math.round(s.pos * 10) / 10);
  const offset = path ? getOffset(path) : 0;
  const idx = lyrics?.synced ? activeLine(lyrics, pos + 0.25 - offset) : -1;

  let lines: { text: string; now?: boolean }[] = [];
  if (lyrics?.synced) {
    lines =
      idx < 0
        ? [{ text: "" }, { text: "" }, { text: lyrics.lines[0]?.text ?? "" }]
        : [idx - 1, idx, idx + 1].map((i) => ({ text: i >= 0 ? (lyrics.lines[i]?.text ?? "") : "", now: i === idx }));
  } else if (lyrics) {
    lines = lyrics.lines.slice(0, 3).map((l) => ({ text: l.text }));
  }

  return (
    <button
      onClick={onOpen}
      aria-label="Open lyrics"
      className="mt-3 flex h-[68px] w-full shrink-0 animate-in flex-col justify-center overflow-hidden text-left fade-in duration-200"
    >
      {lyrics === null ? (
        <span className="text-sm text-muted-foreground">No lyrics</span>
      ) : (
        <div key={idx} className="w-full animate-rise">
          {lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                "truncate leading-[22px]",
                l.now ? "text-[15px] font-semibold text-foreground" : "text-[13px] text-muted-foreground/70",
              )}
            >
              {l.text || (l.now ? <span className="text-brand">♪</span> : " ")}
            </div>
          ))}
        </div>
      )}
    </button>
  );
}

/** Full-screen lyrics over the blurred cover, with the transport kept at hand. */
function LyricsTheater({ lyrics, onClose }: { lyrics: Lyrics | null | undefined; onClose: () => void }) {
  const m = useStore((s) => s.track?.meta);
  const cover = useStore((s) => s.cover);
  const playing = useStore((s) => s.player.playing);
  const path = m?.path;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex animate-in flex-col overflow-hidden bg-background pb-[env(safe-area-inset-bottom)] fade-in slide-in-from-bottom-6 duration-300">
      {cover && (
        <img
          src={cover}
          alt=""
          aria-hidden
          draggable={false}
          className="pointer-events-none absolute inset-0 size-full scale-125 object-cover opacity-60 blur-3xl saturate-150"
        />
      )}
      <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-background/40 via-background/70 to-background" />

      <div className="relative flex shrink-0 items-center gap-3 px-5 pt-3 pb-2">
        <div className="size-11 shrink-0 overflow-hidden rounded-md bg-brand-wash shadow-lg shadow-black/40">
          {cover && <img src={cover} alt="" draggable={false} className="size-full object-cover" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{m?.title}</div>
          <div className="truncate text-xs text-muted-foreground">{m?.artist ?? ""}</div>
        </div>
        <button aria-label="Close lyrics" onClick={onClose} className="-mr-2 rounded-md p-2 text-muted-foreground [&_svg]:size-5">
          <ChevronDown />
        </button>
      </div>

      <div className="relative min-h-0 flex-1 px-5">
        {lyrics ? (
          <LyricsPane lyrics={lyrics} offset={path ? getOffset(path) : 0} />
        ) : lyrics === null ? (
          <div className="pt-[30vh] text-center text-sm text-muted-foreground">No lyrics</div>
        ) : null}
      </div>

      <div className="relative shrink-0 px-5 pt-2 pb-3">
        <SeekBar stacked />
        <div className="mt-1 flex items-center justify-center gap-8">
          <button aria-label="Previous" onClick={() => api.prev()} className="p-2 [&_svg]:size-6 [&_svg]:fill-current">
            <SkipBack />
          </button>
          <button
            aria-label={playing ? "Pause" : "Play"}
            onClick={() => api.toggle()}
            className="flex size-14 items-center justify-center rounded-full bg-brand text-brand-foreground active:scale-95 [&_svg]:size-6 [&_svg]:fill-current"
          >
            {playing ? <Pause /> : <Play className="translate-x-0.5" />}
          </button>
          <button aria-label="Next" onClick={() => api.next()} className="p-2 [&_svg]:size-6 [&_svg]:fill-current">
            <SkipForward />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- crates */

const HISTORY: View[] = [
  { kind: "history", days: 7, name: "Last 7 days" },
  { kind: "history", days: 30, name: "Last 30 days" },
];

/** The node for `path` and its ancestors, top first. */
function locate(nodes: CrateNode[], path: string, trail: CrateNode[] = []): { node: CrateNode; trail: CrateNode[] } | null {
  for (const n of nodes) {
    if (n.path === path) return { node: n, trail };
    const hit = locate(n.children, path, [...trail, n]);
    if (hit) return hit;
  }
  return null;
}

/** Applies the saved order for one level of sub-folders. */
function sortedChildren(n: CrateNode, order: Record<string, string[]> | undefined) {
  const saved = order?.[n.path];
  if (!saved?.length) return n.children;
  const rank = new Map(saved.map((p, i) => [p, i]));
  return n.children
    .map((c, i) => ({ c, r: rank.get(c.path) ?? saved.length + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.c);
}

const crateView = (n: CrateNode): View => ({ kind: "crate", path: n.path, name: n.name });

function Pill({ active, onClick, icon, children }: { active?: boolean; onClick: () => void; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] whitespace-nowrap transition-colors [&_svg]:size-3.5",
        active ? "border-foreground bg-foreground text-background" : "text-foreground/85",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function CratesScreen({ onPlayer }: { onPlayer: () => void }) {
  const crates = useStore((s) => s.crates);
  const view = useStore((s) => s.view);
  const order = useStore((s) => s.config?.crateOrder);
  const smart = useStore((s) => s.config?.smartCrates ?? EMPTY);
  const historyOn = useStore((s) => s.config?.history ?? true);
  const hasRoots = useStore((s) => (s.config ? s.config.roots.length > 0 : true));
  const layout = useStore((s) => s.layout);
  const hasTrack = useStore((s) => !!s.track);
  const st = useStore.getState;
  const key = viewKey(view);

  const here = view?.kind === "crate" ? locate(crates, view.path) : null;
  const top = here ? (here.trail[0] ?? here.node) : null;
  const parent = here?.trail[here.trail.length - 1];
  const subs = here ? sortedChildren(here.node, order) : [];

  return (
    <div className="flex min-h-0 flex-1 animate-in flex-col fade-in slide-in-from-top-4 duration-300">
      <div className="flex h-12 shrink-0 items-center gap-1 px-4">
        <div className="flex-1 text-base font-semibold">Crates</div>
        <button aria-label="Search" onClick={() => st().setPalette(true)} className="rounded-md p-2 text-muted-foreground [&_svg]:size-[18px]">
          <Search />
        </button>
        <button
          aria-label={layout === "albums" ? "Track list" : "Album grid"}
          onClick={() => st().setLayout(layout === "albums" ? "list" : "albums")}
          className="rounded-md p-2 text-muted-foreground [&_svg]:size-[18px]"
        >
          {layout === "albums" ? <Rows3 /> : <LayoutGrid />}
        </button>
        <button aria-label="Settings" onClick={() => st().setSettings(true)} className="-mr-2 rounded-md p-2 text-muted-foreground [&_svg]:size-[18px]">
          <Settings />
        </button>
      </div>

      <div className="flex shrink-0 gap-1.5 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {crates.map((n) => (
          <Pill key={n.path} active={top?.path === n.path} onClick={() => st().openView(crateView(n))}>
            {n.name}
          </Pill>
        ))}
        {smart.map((c) => {
          const v: View = { kind: "smart", id: c.id, name: c.name };
          return (
            <Pill key={c.id} active={key === viewKey(v)} onClick={() => st().openView(v)} icon={<ListFilter />}>
              {c.name}
            </Pill>
          );
        })}
        {historyOn &&
          HISTORY.map((v) => (
            <Pill key={viewKey(v)} active={key === viewKey(v)} onClick={() => st().openView(v)} icon={<History />}>
              {v.name}
            </Pill>
          ))}
        <Pill onClick={addFolder} icon={<FolderPlus />}>
          Add folder
        </Pill>
      </div>

      {(parent || subs.length > 0) && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {parent && (
            <button
              onClick={() => st().openView(crateView(parent))}
              className="flex h-7 shrink-0 items-center gap-0.5 pr-1 text-[13px] text-muted-foreground [&_svg]:size-4"
            >
              <ChevronLeft />
              {here!.node.name}
            </button>
          )}
          {subs.map((c) => (
            <button
              key={c.path}
              onClick={() => st().openView(crateView(c))}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-secondary px-2.5 text-[13px] whitespace-nowrap [&_svg]:size-3.5 [&_svg]:text-muted-foreground"
            >
              <Folder />
              {c.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {hasRoots ? (
          layout === "albums" ? (
            <Suspense fallback={null}>
              <AlbumGrid />
            </Suspense>
          ) : (
            <TrackList />
          )
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <button
              onClick={addFolder}
              className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-2.5 text-muted-foreground"
            >
              <FolderPlus className="size-4" /> Add folder
            </button>
          </div>
        )}
      </div>

      {hasTrack && <MiniPlayer onOpen={onPlayer} />}
    </div>
  );
}

/* ------------------------------------------------------------ mini player */

function MiniPlayer({ onOpen }: { onOpen: () => void }) {
  const m = useStore((s) => s.track?.meta);
  const cover = useStore((s) => s.cover);
  const playing = useStore((s) => s.player.playing);
  const frac = useStore((s) => (s.duration > 0 ? Math.min(1, s.pos / s.duration) : 0));
  const y0 = useRef<number | null>(null);

  return (
    <div
      role="button"
      aria-label="Open player"
      onClick={(e) => !(e.target as HTMLElement).closest("button") && onOpen()}
      onPointerDown={(e) => (y0.current = e.clientY)}
      onPointerUp={(e) => {
        if (y0.current != null && y0.current - e.clientY > 40) onOpen();
        y0.current = null;
      }}
      className="relative mx-2 mt-1 mb-2 shrink-0 animate-in overflow-hidden rounded-xl bg-brand-muted p-2 fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="flex items-center gap-2.5">
        <div className="size-10 shrink-0 overflow-hidden rounded-md bg-brand-wash">
          {cover && <img src={cover} alt="" draggable={false} className="size-full object-cover" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{m?.title}</div>
          <div className="truncate text-xs text-brand-muted-foreground">{m?.artist ?? (m ? basename(m.path) : "")}</div>
        </div>
        <button
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => api.toggle()}
          className="p-2 [&_svg]:size-5 [&_svg]:fill-current"
        >
          {playing ? <Pause /> : <Play />}
        </button>
        <button aria-label="Next" onClick={() => api.next()} className="-ml-1 p-2 text-brand-muted-foreground [&_svg]:size-5 [&_svg]:fill-current">
          <SkipForward />
        </button>
      </div>
      <div className="absolute inset-x-2 bottom-0 h-0.5 overflow-hidden rounded-full bg-brand/20">
        <div className="h-full bg-brand" style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  );
}
