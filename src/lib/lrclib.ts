import { api, type Lyrics, type LyricsFound } from "./api";
import { similarity } from "./itunes";

// LRCLIB (https://lrclib.net) — free, keyless, CORS-enabled. Only used when
// "Download lyrics from LRCLIB" is on. Results (including misses) are cached
// by the backend, so each track is looked up at most once.
//
// Many songs exist in several cuts (radio edit, remix, extended) whose lyric
// text is identical but timings differ. Synced lyrics are therefore only
// accepted automatically when the version's length is within SYNC_TOLERANCE
// of the file; otherwise plain (unsynced) text is used. The versions picker
// lets the user choose any version explicitly.

const BASE = "https://lrclib.net/api";
const SYNC_TOLERANCE = 2;

interface Hit {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  instrumental?: boolean;
}

export interface Version {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration: number;
  synced: boolean;
  raw: string | null;
  /** Seconds between this version's length and the file's. */
  diff: number;
}

async function getJson<T>(url: string): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

const text = (h: Hit, synced: boolean) =>
  (synced ? h.syncedLyrics : h.plainLyrics)?.trim() ? (synced ? h.syncedLyrics! : h.plainLyrics!) : null;

/** Every LRCLIB version of a song, closest length first. */
export async function versions(artist: string, title: string, duration: number): Promise<Version[]> {
  const queries = [
    new URLSearchParams({ track_name: title, ...(artist ? { artist_name: artist } : {}) }),
    new URLSearchParams({ track_name: title }),
    new URLSearchParams({ q: `${artist} ${title}`.trim() }),
  ];
  const seen = new Set<number>();
  const out: Version[] = [];
  const results = await Promise.all(queries.map((q) => getJson<Hit[]>(`${BASE}/search?${q}`).catch(() => null)));
  for (const list of results) {
    for (const h of list ?? []) {
      if (h.id == null || seen.has(h.id) || h.instrumental) continue;
      if (similarity(title, h.trackName ?? "") < 0.5) continue;
      seen.add(h.id);
      const synced = !!h.syncedLyrics?.trim();
      const raw = text(h, synced) ?? text(h, !synced);
      if (!raw) continue;
      out.push({
        id: h.id,
        title: h.trackName ?? "",
        artist: h.artistName ?? "",
        album: h.albumName ?? "",
        duration: h.duration ?? 0,
        synced,
        raw,
        diff: duration > 0 && h.duration ? Math.abs(h.duration - duration) : Infinity,
      });
    }
  }
  const artistScore = (v: Version) => (artist ? similarity(artist, v.artist) : 0);
  return out.sort((a, b) => a.diff - b.diff || artistScore(b) - artistScore(a) || Number(b.synced) - Number(a.synced));
}

async function lookup(q: NonNullable<LyricsFound["lookup"]>): Promise<string | null> {
  // Exact endpoint already enforces a tight duration window on LRCLIB's side.
  const params = new URLSearchParams({ artist_name: q.artist, track_name: q.title });
  if (q.album) params.set("album_name", q.album);
  if (q.duration > 0) params.set("duration", String(Math.round(q.duration)));
  const exact = await getJson<Hit>(`${BASE}/get?${params}`);
  if (exact && !exact.instrumental) {
    const d = exact.duration ? Math.abs(exact.duration - q.duration) : 0;
    const synced = text(exact, true);
    if (synced && (q.duration <= 0 || d <= SYNC_TOLERANCE)) return synced;
  }

  const all = await versions(q.artist, q.title, q.duration);
  const timed = all.find((v) => v.synced && v.diff <= SYNC_TOLERANCE);
  if (timed) return timed.raw;
  // No version with a matching length: words without (wrong) timing.
  const plain = exact ? text(exact, false) : null;
  if (plain) return plain;
  const any = all.find((v) => v.raw);
  if (!any?.raw) return null;
  return any.synced ? stripTimes(any.raw) : any.raw;
}

/** Turns LRC into plain text by removing [mm:ss.xx] stamps. */
export function stripTimes(lrc: string): string {
  return lrc
    .split(/\r?\n/)
    .map((l) => l.replace(/\[[0-9:.]+\]/g, "").trim())
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]))
    .join("\n");
}

/** Local (.lrc / embedded) first, then cache, then LRCLIB when allowed. */
export async function loadLyrics(path: string): Promise<Lyrics | null> {
  const found = await api.lyrics(path);
  if (found.lyrics || !found.lookup) return found.lyrics;
  let raw: string | null = null;
  try {
    raw = await lookup(found.lookup);
  } catch {
    // Network failure: don't cache, try again next time.
    return null;
  }
  return api.storeLyrics(path, raw, false);
}

/** Pins a user-chosen version for this track (overrides local and cached). */
export function chooseVersion(path: string, v: Version): Promise<Lyrics | null> {
  return api.storeLyrics(path, v.raw, true);
}

// Per-track timing offset (seconds), a per-machine convenience.
const OFFSET_KEY = "mono.lyrics.offset";
function offsets(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(OFFSET_KEY) ?? "{}");
  } catch {
    return {};
  }
}
export const getOffset = (path: string) => offsets()[path] ?? 0;
export function setOffset(path: string, value: number) {
  const all = offsets();
  if (Math.abs(value) < 0.001) delete all[path];
  else all[path] = Math.round(value * 100) / 100;
  try {
    localStorage.setItem(OFFSET_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
