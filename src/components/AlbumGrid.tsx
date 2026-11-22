import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Disc3, Play } from "lucide-react";
import { api, type TrackMeta } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn, fmtTime } from "@/lib/utils";

interface Album {
  key: string;
  name: string;
  artist: string;
  year?: number | null;
  tracks: TrackMeta[];
}

// Downscaled covers by track path, kept for the session.
const thumbs = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

async function shrink(src: string, size = 320): Promise<string> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const k = Math.min(1, size / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}

function loadThumb(path: string): Promise<string | null> {
  if (thumbs.has(path)) return Promise.resolve(thumbs.get(path)!);
  let p = pending.get(path);
  if (!p) {
    p = api
      .cover(path)
      .then((url) => (url ? shrink(url) : null))
      .catch(() => null)
      .then((t) => {
        thumbs.set(path, t);
        pending.delete(path);
        return t;
      });
    pending.set(path, p);
  }
  return p;
}

/** Cover that loads only once scrolled into view. */
function Cover({ path, className }: { path: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(thumbs.get(path) ?? null);
  useEffect(() => {
    if (thumbs.has(path)) return setSrc(thumbs.get(path)!);
    const el = ref.current;
    if (!el) return;
    let live = true;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          loadThumb(path).then((t) => live && setSrc(t));
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [path]);
  return (
    <div ref={ref} className={cn("flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-secondary", className)}>
      {src ? (
        <img src={src} alt="" className="size-full object-cover" draggable={false} />
      ) : (
        <Disc3 className="size-1/3 text-muted-foreground/30" />
      )}
    </div>
  );
}

function group(list: TrackMeta[]): Album[] {
  const map = new Map<string, Album>();
  for (const m of list) {
    const name = m.album?.trim() || "Singles";
    const artist = (m.albumArtist || m.artist || "").trim();
    const key = m.album?.trim() ? `${name.toLowerCase()}\u0000${artist.toLowerCase()}` : "\u0000singles";
    let a = map.get(key);
    if (!a) {
      a = { key, name, artist: m.album?.trim() ? artist : "Various", year: m.year, tracks: [] };
      map.set(key, a);
    }
    a.tracks.push(m);
  }
  const albums = [...map.values()];
  for (const a of albums) {
    a.tracks.sort((x, y) => (x.disc ?? 1) - (y.disc ?? 1) || (x.track ?? 999) - (y.track ?? 999));
  }
  return albums.sort((x, y) => x.artist.localeCompare(y.artist) || x.name.localeCompare(y.name));
}

function playAlbum(a: Album, from = 0) {
  useStore.setState({ queueKey: null, userQueueEnd: null, unshuffled: null });
  api.playQueue(
    a.tracks.map((t) => t.path),
    from,
  );
}

function AlbumPage({ album, onBack }: { album: Album; onBack: () => void }) {
  const playing = useStore((s) => s.track?.meta.path);
  const total = album.tracks.reduce((s, t) => s + t.duration, 0);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex items-end gap-5 p-5">
        <Cover path={album.tracks[0].path} className="w-40 shrink-0 shadow-lg" />
        <div className="min-w-0 flex-1">
          <button onClick={onBack} className="mb-3 flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" /> All albums
          </button>
          <div className="truncate text-xl font-semibold">{album.name}</div>
          <div className="truncate text-muted-foreground">
            {[album.artist, album.year].filter(Boolean).join(" · ")}
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">
            {album.tracks.length} tracks · {fmtTime(total)}
          </div>
          <button
            onClick={() => playAlbum(album)}
            className="mt-3 flex items-center gap-1.5 rounded-full bg-brand px-4 py-1.5 text-[13px] font-medium text-brand-foreground hover:bg-brand-strong [&_svg]:size-3.5 [&_svg]:fill-current"
          >
            <Play /> Play
          </button>
        </div>
      </div>
      <div className="px-3 pb-4">
        {album.tracks.map((t, i) => (
          <div
            key={t.path}
            onDoubleClick={() => playAlbum(album, i)}
            className={cn(
              "flex h-8 cursor-default items-center gap-3 rounded-md px-3 font-mono text-[12px] text-muted-foreground hover:bg-accent/60",
              t.path === playing && "bg-brand-wash text-brand",
            )}
          >
            <span className="w-6 tabular-nums">{String(t.track ?? i + 1).padStart(2, "0")}</span>
            <span className={cn("min-w-0 flex-1 truncate", t.path !== playing && "text-foreground")}>{t.title}</span>
            <span className="hidden min-w-0 flex-1 truncate sm:block">{t.artist}</span>
            <span className="tabular-nums">{fmtTime(t.duration)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AlbumGrid() {
  const list = useStore((s) => s.list);
  const view = useStore((s) => s.view);
  const albums = useMemo(() => group(list), [list]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => setOpen(null), [view]);

  const current = albums.find((a) => a.key === open);
  if (current) return <AlbumPage album={current} onBack={() => setOpen(null)} />;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-4 gap-y-5">
        {albums.map((a) => (
          <div key={a.key} className="group min-w-0 cursor-default" onClick={() => setOpen(a.key)}>
            <div className="relative">
              <Cover path={a.tracks[0].path} className="transition-transform group-hover:scale-[1.02]" />
              <button
                aria-label={`Play ${a.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  playAlbum(a);
                }}
                className="absolute right-2 bottom-2 flex size-9 translate-y-1 items-center justify-center rounded-full bg-brand text-brand-foreground opacity-0 shadow-lg transition-all group-hover:translate-y-0 group-hover:opacity-100 hover:scale-105 [&_svg]:size-4 [&_svg]:fill-current"
              >
                <Play className="translate-x-px" />
              </button>
            </div>
            <div className="mt-2 truncate text-[13px] font-medium">{a.name}</div>
            <div className="truncate text-[12px] text-muted-foreground">
              {a.artist}
              {a.tracks.length > 1 ? ` · ${a.tracks.length}` : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
