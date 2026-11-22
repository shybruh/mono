import { api, type Lyrics, type LyricsFound } from "./api";

// LRCLIB (https://lrclib.net) — free, keyless, CORS-enabled. Only used when
// "Download lyrics from LRCLIB" is on. Results (including misses) are cached
// by the backend, so each track is looked up at most once.

interface Hit {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  instrumental?: boolean;
  duration?: number;
}

const BASE = "https://lrclib.net/api";

function pick(hit: Hit | null | undefined): string | null {
  if (!hit || hit.instrumental) return null;
  if (hit.syncedLyrics?.trim()) return hit.syncedLyrics;
  if (hit.plainLyrics?.trim()) return hit.plainLyrics;
  return null;
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

async function lookup(q: NonNullable<LyricsFound["lookup"]>): Promise<string | null> {
  const params = new URLSearchParams({ artist_name: q.artist, track_name: q.title });
  if (q.album) params.set("album_name", q.album);
  if (q.duration > 0) params.set("duration", String(Math.round(q.duration)));
  const exact = pick(await getJson<Hit>(`${BASE}/get?${params}`));
  if (exact) return exact;

  const loose = new URLSearchParams({ artist_name: q.artist, track_name: q.title });
  const hits = (await getJson<Hit[]>(`${BASE}/search?${loose}`)) ?? [];
  for (const h of hits) {
    if (q.duration > 0 && h.duration && Math.abs(h.duration - q.duration) > 4) continue;
    const text = pick(h);
    if (text) return text;
  }
  return null;
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
  return api.storeLyrics(path, raw);
}
