// Track metadata + cover art lookup via the iTunes Search API
// (https://itunes.apple.com/search) — free, keyless, CORS-enabled.

import type { TrackMeta } from "./api";

export interface Match {
  title: string;
  artist: string;
  album: string;
  albumArtist?: string;
  genre?: string;
  year?: number;
  track?: number;
  trackTotal?: number;
  disc?: number;
  duration?: number;
  artwork: string;
  thumb: string;
  /** 0..1 confidence that this is the same recording. */
  score: number;
}

interface Raw {
  kind?: string;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  collectionArtistName?: string;
  primaryGenreName?: string;
  releaseDate?: string;
  trackNumber?: number;
  trackCount?: number;
  discNumber?: number;
  trackTimeMillis?: number;
  artworkUrl100?: string;
}

/** Lower-case, drop bracketed noise and "feat." credits, keep words. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\((?:official|lyric|audio|video|hd|hq|visuali[sz]er)[^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function words(s: string): Set<string> {
  return new Set(normalize(s).split(" ").filter(Boolean));
}

/** Word-overlap similarity (Dice coefficient), 0..1. */
export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return (2 * common) / (A.size + B.size);
}

function score(r: Raw, artist: string, title: string, duration: number): number {
  const t = similarity(title, r.trackName ?? "");
  const a = artist ? similarity(artist, r.artistName ?? "") : 0.5;
  let s = t * 0.6 + a * 0.4;
  const d = (r.trackTimeMillis ?? 0) / 1000;
  if (duration > 0 && d > 0) {
    const diff = Math.abs(d - duration);
    s *= diff <= 3 ? 1 : diff <= 10 ? 0.85 : 0.6;
  }
  return Math.max(0, Math.min(1, s));
}

function toMatch(r: Raw, s: number): Match {
  const art = r.artworkUrl100 ?? "";
  return {
    title: r.trackName ?? "",
    artist: r.artistName ?? "",
    album: r.collectionName ?? "",
    albumArtist: r.collectionArtistName,
    genre: r.primaryGenreName,
    year: r.releaseDate ? Number(r.releaseDate.slice(0, 4)) || undefined : undefined,
    track: r.trackNumber,
    trackTotal: r.trackCount,
    disc: r.discNumber,
    duration: r.trackTimeMillis ? r.trackTimeMillis / 1000 : undefined,
    artwork: art.replace(/\/\d+x\d+bb\./, "/1200x1200bb."),
    thumb: art.replace(/\/\d+x\d+bb\./, "/120x120bb."),
    score: s,
  };
}

const memo = new Map<string, Promise<Match[]>>();

/** Candidates for a track, best first. */
export function search(artist: string, title: string, duration = 0): Promise<Match[]> {
  const term = [artist, title].filter(Boolean).join(" ").trim();
  if (!term) return Promise.resolve([]);
  const key = `${term}|${Math.round(duration)}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const p = (async () => {
    const url = `https://itunes.apple.com/search?${new URLSearchParams({
      term,
      media: "music",
      entity: "song",
      limit: "15",
    })}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) return [];
      const json = (await r.json()) as { results?: Raw[] };
      return (json.results ?? [])
        .filter((x) => x.kind === "song" && x.trackName)
        .map((x) => toMatch(x, score(x, artist, title, duration)))
        .sort((a, b) => b.score - a.score);
    } finally {
      clearTimeout(timer);
    }
  })();
  p.catch(() => memo.delete(key));
  memo.set(key, p);
  return p;
}

/** Confident single match for automatic use, or null. */
export async function best(meta: TrackMeta, threshold = 0.72): Promise<Match | null> {
  const list = await search(meta.artist ?? "", meta.title, meta.duration);
  return list[0] && list[0].score >= threshold ? list[0] : null;
}

/** Downloads artwork as base64 for embedding. */
export async function fetchArtwork(url: string): Promise<{ data: string; mime: string }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`artwork ${r.status}`);
  const blob = await r.blob();
  const data = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1] ?? "");
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
  return { data, mime: blob.type || "image/jpeg" };
}
