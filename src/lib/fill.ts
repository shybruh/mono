import { create } from "zustand";
import { api, type TrackMeta } from "./api";
import { best, fetchArtwork } from "./itunes";
import { useStore } from "./store";

// Bulk "fill missing info": for each track missing album or cover art, take a
// confident iTunes match and write only the fields that are empty, plus the
// cover if none is embedded. Paced for iTunes' ~20 requests/minute limit.

const SPACING_MS = 3200;

interface FillState {
  running: boolean;
  done: number;
  total: number;
  updated: number;
  cancel: () => void;
}

let cancelled = false;

export const useFill = create<FillState>(() => ({
  running: false,
  done: 0,
  total: 0,
  updated: 0,
  cancel: () => {
    cancelled = true;
  },
}));

export const needsInfo = (m: TrackMeta) => !m.album || !m.hasCover || m.inferred;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fillOne(m: TrackMeta): Promise<boolean> {
  const match = await best(m);
  if (!match) return false;
  const keep = <T,>(cur: T | null | undefined, next: T | undefined) =>
    cur != null && cur !== "" ? cur : (next ?? null);
  await api.writeTags(m.path, {
    title: m.inferred ? match.title : m.title,
    artist: m.inferred ? match.artist : keep(m.artist, match.artist),
    album: keep(m.album, match.album),
    albumArtist: keep(m.albumArtist, match.albumArtist),
    genre: keep(m.genre, match.genre),
    year: keep(m.year, match.year),
    track: keep(m.track, match.track),
    trackTotal: keep(m.trackTotal, match.trackTotal),
    disc: keep(m.disc, match.disc),
  });
  if (!m.hasCover && match.artwork) {
    const art = await fetchArtwork(match.artwork);
    await api.setCoverData(m.path, art.data, art.mime);
  }
  return true;
}

export async function fillMissing(tracks: TrackMeta[]) {
  if (useFill.getState().running) return;
  const todo = tracks.filter(needsInfo);
  if (!todo.length) return;
  cancelled = false;
  useFill.setState({ running: true, done: 0, total: todo.length, updated: 0 });
  for (let i = 0; i < todo.length && !cancelled; i++) {
    try {
      if (await fillOne(todo[i])) useFill.setState((s) => ({ updated: s.updated + 1 }));
    } catch {
      /* skip this one */
    }
    useFill.setState({ done: i + 1 });
    if (i + 1 < todo.length && !cancelled) await sleep(SPACING_MS);
  }
  useFill.setState({ running: false });
  useStore.getState().reloadList();
}
