// Track-list columns: one registry for headers, cells, sorting, widths and
// the right-click column chooser.

import type { TrackMeta } from "./api";
import { formatKey, keySortValue, type KeyNotation } from "./keys";
import { basename, fmtTime } from "./utils";

export type ColId =
  | "num"
  | "title"
  | "artist"
  | "album"
  | "albumArtist"
  | "genre"
  | "year"
  | "bpm"
  | "key"
  | "gain"
  | "bitrate"
  | "format"
  | "added"
  | "time";

export interface CellCtx {
  rgMode: string;
  keyNotation: KeyNotation;
  index: number;
}

export interface ColumnDef {
  id: ColId;
  label: string;
  width: number;
  min: number;
  max: number;
  /** Shrinks toward `min` when the window is narrow. */
  flex?: boolean;
  align?: "right";
  /** Cannot be hidden. */
  fixed?: boolean;
  text: (m: TrackMeta, c: CellCtx) => string;
  sort?: (m: TrackMeta, c: CellCtx) => string | number | null;
}

function gainOf(m: TrackMeta, mode: string): number | null {
  if (mode === "off") return null;
  return mode === "album" ? (m.rgAlbumGain ?? m.rgTrackGain ?? null) : (m.rgTrackGain ?? m.rgAlbumGain ?? null);
}

const lower = (s: string | null | undefined) => (s ? s.toLowerCase() : null);

export const COLUMNS: ColumnDef[] = [
  {
    id: "num",
    label: "#",
    width: 44,
    min: 28,
    max: 90,
    fixed: true,
    text: (m, c) => String(m.track ?? c.index + 1).padStart(2, "0"),
    sort: (m) => (m.disc ?? 1) * 1000 + (m.track ?? 999),
  },
  {
    id: "title",
    label: "Title",
    width: 320,
    min: 120,
    max: 1200,
    flex: true,
    fixed: true,
    text: (m) => m.title || basename(m.path),
    sort: (m) => lower(m.title),
  },
  { id: "artist", label: "Artist", width: 190, min: 60, max: 800, flex: true, text: (m) => m.artist ?? "", sort: (m) => lower(m.artist) },
  { id: "album", label: "Album", width: 190, min: 60, max: 800, flex: true, text: (m) => m.album ?? "", sort: (m) => lower(m.album) },
  {
    id: "albumArtist",
    label: "Album artist",
    width: 160,
    min: 60,
    max: 800,
    flex: true,
    text: (m) => m.albumArtist ?? "",
    sort: (m) => lower(m.albumArtist),
  },
  { id: "genre", label: "Genre", width: 120, min: 50, max: 400, flex: true, text: (m) => m.genre ?? "", sort: (m) => lower(m.genre) },
  { id: "year", label: "Year", width: 56, min: 44, max: 100, text: (m) => (m.year ? String(m.year) : ""), sort: (m) => m.year ?? null },
  {
    id: "bpm",
    label: "BPM",
    width: 56,
    min: 44,
    max: 100,
    align: "right",
    text: (m) => (m.bpm ? (Number.isInteger(m.bpm) ? String(m.bpm) : m.bpm.toFixed(1)) : ""),
    sort: (m) => m.bpm ?? null,
  },
  {
    id: "key",
    label: "Key",
    width: 52,
    min: 40,
    max: 100,
    text: (m, c) => formatKey(m.key, c.keyNotation),
    sort: (m) => keySortValue(m.key),
  },
  {
    id: "gain",
    label: "Gain",
    width: 76,
    min: 48,
    max: 160,
    text: (m, c) => {
      const g = gainOf(m, c.rgMode);
      return g == null ? "—" : `${g < 0 ? "−" : "+"}${Math.abs(g).toFixed(1)} dB`;
    },
    sort: (m, c) => gainOf(m, c.rgMode),
  },
  {
    id: "bitrate",
    label: "Bitrate",
    width: 72,
    min: 50,
    max: 120,
    align: "right",
    text: (m) => (m.bitrate ? `${m.bitrate}k` : ""),
    sort: (m) => m.bitrate ?? null,
  },
  { id: "format", label: "Format", width: 60, min: 44, max: 100, text: (m) => m.format, sort: (m) => m.format },
  {
    id: "added",
    label: "Added",
    width: 92,
    min: 70,
    max: 140,
    text: (m) => (m.mtime ? new Date(m.mtime * 1000).toLocaleDateString() : ""),
    sort: (m) => m.mtime || null,
  },
  {
    id: "time",
    label: "Time",
    width: 60,
    min: 44,
    max: 160,
    align: "right",
    text: (m) => fmtTime(m.duration),
    sort: (m) => m.duration,
  },
];

export const COLUMN = Object.fromEntries(COLUMNS.map((c) => [c.id, c])) as Record<ColId, ColumnDef>;

export const DEFAULT_VISIBLE: ColId[] = ["num", "title", "artist", "album", "bpm", "key", "gain", "time"];

export interface SortState {
  col: ColId;
  dir: 1 | -1;
}

/** Stable sort; empty values always last regardless of direction. */
export function sortTracks(list: TrackMeta[], sort: SortState | null, ctx: Omit<CellCtx, "index">): TrackMeta[] {
  if (!sort) return list;
  const get = COLUMN[sort.col].sort;
  if (!get) return list;
  const keyed = list.map((m, i) => ({ m, i, v: get(m, { ...ctx, index: i }) }));
  keyed.sort((a, b) => {
    const av = a.v;
    const bv = b.v;
    if (av == null || av === "") return bv == null || bv === "" ? a.i - b.i : 1;
    if (bv == null || bv === "") return -1;
    const c = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true });
    return c === 0 ? a.i - b.i : c * sort.dir;
  });
  return keyed.map((k) => k.m);
}
