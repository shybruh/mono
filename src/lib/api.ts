import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Repeat = "off" | "all" | "one";

export interface TrackMeta {
  path: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  genre?: string | null;
  year?: number | null;
  track?: number | null;
  trackTotal?: number | null;
  disc?: number | null;
  duration: number;
  bitrate?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
  bitDepth?: number | null;
  format: string;
  rgTrackGain?: number | null;
  rgTrackPeak?: number | null;
  rgAlbumGain?: number | null;
  rgAlbumPeak?: number | null;
  hasCover: boolean;
}

export interface CrateNode {
  name: string;
  path: string;
  kind: "folder" | "playlist";
  children: CrateNode[];
}

export interface IndexEntry {
  path: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  dir: string;
}

export interface Config {
  roots: string[];
  volume: number;
  rgMode: "off" | "track" | "album";
  rgPreamp: number;
  repeat: Repeat;
  history: boolean;
  discord: boolean;
  discordAppId: string;
  theme: string;
  customTheme: { bg: string; fg: string; accent: string };
  deckMeters: string[];
  vizOpen: boolean;
  vizMeters: string[];
  coverAccent: boolean;
}

export interface PlayerState {
  playing: boolean;
  index: number | null;
  queue: string[];
  speed: number;
  semitones: number;
  volume: number;
  loopA: number | null;
  loopB: number | null;
  repeat: Repeat;
  rgMode: string;
  rgPreamp: number;
}

export interface TrackEvent {
  index: number;
  meta: TrackMeta;
  gainDb: number;
}

export interface PositionEvent {
  pos: number;
  duration: number;
}

export interface Meters {
  spectrum: number[];
  scope: number[];
  peakL: number;
  peakR: number;
  lufsM: number;
  lufsS: number;
}

export interface TagEdit {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  genre?: string | null;
  year?: number | null;
  track?: number | null;
  trackTotal?: number | null;
  disc?: number | null;
}

export const api = {
  getConfig: () => invoke<Config>("get_config"),
  updateConfig: (patch: Partial<Config>) => invoke<Config>("update_config", { patch }),

  crates: () => invoke<CrateNode[]>("crates"),
  tracks: (path: string) => invoke<TrackMeta[]>("tracks", { path }),
  historyTracks: (days: number) => invoke<TrackMeta[]>("history_tracks", { days }),
  libraryIndex: () => invoke<IndexEntry[]>("library_index"),
  trackMeta: (path: string) => invoke<TrackMeta>("track_meta", { path }),
  waveform: (path: string, buckets: number) => invoke<number[]>("waveform", { path, buckets }),
  cover: (path: string) => invoke<string | null>("cover", { path }),
  savePlaylist: (path: string, tracks: string[]) => invoke<void>("save_playlist", { path, tracks }),

  writeTags: (path: string, tags: TagEdit) => invoke<TrackMeta>("write_tags", { path, tags }),
  setCover: (path: string, image: string) => invoke<void>("set_cover", { path, image }),
  removeCover: (path: string) => invoke<void>("remove_cover", { path }),
  renumber: (paths: string[]) => invoke<void>("renumber", { paths }),

  playQueue: (paths: string[], index: number) => invoke<void>("play_queue", { paths, index }),
  setQueue: (paths: string[], index: number) => invoke<void>("set_queue", { paths, index }),
  playIndex: (index: number) => invoke<void>("play_index", { index }),
  toggle: () => invoke<void>("toggle"),
  play: () => invoke<void>("play"),
  pause: () => invoke<void>("pause"),
  next: () => invoke<void>("next"),
  prev: () => invoke<void>("prev"),
  seek: (pos: number) => invoke<void>("seek", { pos }),
  seekRelative: (delta: number) => invoke<void>("seek_relative", { delta }),
  setLoop: (a: number | null, b: number | null) => invoke<void>("set_loop", { a, b }),
  setSpeed: (speed: number) => invoke<void>("set_speed", { speed }),
  setPitch: (semitones: number) => invoke<void>("set_pitch", { semitones }),
  setVolume: (volume: number) => invoke<void>("set_volume", { volume }),
  setRepeat: (repeat: Repeat) => invoke<void>("set_repeat", { repeat }),
  syncState: () => invoke<void>("sync_state"),
  setMeters: (on: boolean, seq: number) => invoke<void>("set_meters", { on, seq }),

  openDeck: () => invoke<void>("open_deck"),
  closeDeck: () => invoke<void>("close_deck"),
  quit: () => invoke<void>("quit"),
};

export const on = {
  state: (cb: (s: PlayerState) => void): Promise<UnlistenFn> =>
    listen<PlayerState>("player-state", (e) => cb(e.payload)),
  track: (cb: (t: TrackEvent) => void) => listen<TrackEvent>("track", (e) => cb(e.payload)),
  position: (cb: (p: PositionEvent) => void) => listen<PositionEvent>("position", (e) => cb(e.payload)),
  meters: (cb: (m: Meters) => void) => listen<Meters>("meters", (e) => cb(e.payload)),
  config: (cb: (c: Config) => void) => listen<Config>("config", (e) => cb(e.payload)),
  libraryChanged: (cb: (dirs: string[]) => void) =>
    listen<string[]>("library-changed", (e) => cb(e.payload)),
  libraryIndexed: (cb: () => void) => listen("library-indexed", () => cb()),
};
