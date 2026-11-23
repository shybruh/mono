import { create } from "zustand";
import { flushSync } from "react-dom";
import { centreOf, zoomTransition } from "./motion";
import { coverUrl, preload } from "./cover";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  api,
  on,
  type Config,
  type CrateNode,
  type PlayerState,
  type Repeat,
  type TrackEvent,
  type TrackMeta,
} from "./api";
import { accentFromImage } from "./accent";
import { applyTheme, resolveTheme } from "./theme";
import { best } from "./itunes";
import { sortTracks, type ColId, type SortState } from "./columns";
import type { KeyNotation } from "./keys";

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function saveJSON(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

function shuffled<T>(a: T[]): T[] {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Applies the current sort to a folder-ordered list. */
function arrange(base: TrackMeta[]): TrackMeta[] {
  const s = useStore.getState();
  return sortTracks(base, s.sort, { rgMode: s.config?.rgMode ?? "track", keyNotation: s.keyNotation });
}

/** Re-sorts the visible list, keeping the focused row on the same track. */
function rearrange() {
  const s = useStore.getState();
  const focusPath = s.selected != null ? s.list[s.selected]?.path : null;
  const list = arrange(s.baseList);
  const focus = focusPath ? list.findIndex((m) => m.path === focusPath) : -1;
  useStore.setState({ list, selected: focus >= 0 ? focus : s.selected });
}

/** Stable empty array for selector fallbacks (a fresh [] would re-render forever). */
export const EMPTY: never[] = [];

export type View =
  | { kind: "crate"; path: string; name: string }
  | { kind: "history"; days: number; name: string }
  | { kind: "smart"; id: string; name: string };

export const viewKey = (v: View | null) =>
  !v ? "" : v.kind === "crate" ? `crate:${v.path}` : v.kind === "smart" ? `smart:${v.id}` : `history:${v.days}`;

/** Loads the tracks of any view kind. */
async function fetchView(v: View): Promise<TrackMeta[]> {
  if (v.kind === "crate") return api.tracks(v.path);
  if (v.kind === "history") return api.historyTracks(v.days);
  const def = useStore.getState().config?.smartCrates?.find((c) => c.id === v.id);
  return def ? api.smartTracks(def) : [];
}

interface Store {
  ready: boolean;
  config: Config | null;
  player: PlayerState;
  track: TrackEvent | null;
  pos: number;
  duration: number;
  cover: string | null;

  crates: CrateNode[];
  view: View | null;
  /** Tracks in folder / playlist order. */
  baseList: TrackMeta[];
  /** Tracks as displayed (sorted). Playback order follows this. */
  list: TrackMeta[];
  listLoading: boolean;
  /** Keyboard focus row. */
  selected: number | null;
  /** Selected track paths (multi-select). */
  selection: string[];
  anchor: number | null;
  sort: SortState | null;
  keyNotation: KeyNotation;
  queueKey: string | null;

  palette: boolean;
  settings: boolean;
  /** Tracks open in the tag drawer (several = bulk edit). */
  tagTarget: string[] | null;
  /** Smart crate open in the editor (new or existing). */
  smartEdit: import("./api").SmartCrate | null;
  setSmartEdit: (c: import("./api").SmartCrate | null) => void;
  theater: boolean;
  toggleTheater: (v?: boolean, origin?: { x: number; y: number }) => void;
  fullscreen: boolean;
  toggleFullscreen: (v?: boolean) => void;

  init: (opts?: { library?: boolean }) => Promise<void>;
  setConfig: (patch: Partial<Config>) => Promise<void>;
  refreshCrates: () => Promise<void>;
  openView: (v: View) => Promise<void>;
  reloadList: () => Promise<void>;
  playFromList: (i: number) => void;
  select: (i: number | null) => void;
  clickRow: (i: number, mods: { ctrl?: boolean; shift?: boolean }) => void;
  extendTo: (i: number) => void;
  selectAll: () => void;
  selectedTracks: () => TrackMeta[];
  setSort: (col: ColId) => void;
  /** Queue position after which "Add to queue" inserts (user-queued block end). */
  userQueueEnd: number | null;
  shuffle: boolean;
  /** Queue order before shuffling, restored when shuffle is turned off. */
  unshuffled: string[] | null;
  queueOpen: boolean;
  eqOpen: boolean;
  /** Crates drawer on phone-width layouts. */
  navOpen: boolean;
  /** What's being dragged over the window: a folder (becomes a crate) or audio (plays). */
  dropping: "folder" | "audio" | null;
  setNavOpen: (v: boolean) => void;
  /** Track list or album grid. */
  layout: "list" | "albums";
  setLayout: (l: "list" | "albums") => void;
  playNext: (paths: string[]) => void;
  addToQueue: (paths: string[]) => void;
  setQueueOrder: (paths: string[], index: number) => void;
  toggleShuffle: () => void;
  setQueueOpen: (v: boolean) => void;
  setEqOpen: (v: boolean) => void;
  setKeyNotation: (n: KeyNotation) => void;
  setPalette: (v: boolean) => void;
  setSettings: (v: boolean) => void;
  openTags: (paths: string | string[] | null) => void;

  toggleViz: () => void;
  cycleRepeat: () => void;
  setA: () => void;
  setB: () => void;
  clearLoop: () => void;
}

const initialPlayer: PlayerState = {
  playing: false,
  index: null,
  queue: [],
  speed: 1,
  semitones: 0,
  volume: 0.8,
  loopA: null,
  loopB: null,
  repeat: "off",
  rgMode: "track",
  rgPreamp: 0,
};

let coverReq = 0;
let coverHC: { h: number; c: number } | null = null;

export function refreshTheme() {
  const c = useStore.getState().config;
  if (!c) return;
  applyTheme(resolveTheme(c.theme, c.customTheme, coverHC, c.coverAccent));
}

/**
 * Display-only enrichment from iTunes when the file lacks album info or
 * cover art. Nothing is written to the file; the tag drawer does that.
 */
async function enrich(meta: TrackMeta, req: number): Promise<string | null> {
  if (!useStore.getState().config?.metaOnline) return null;
  if (meta.hasCover && meta.album) return null;
  const m = await best(meta).catch(() => null);
  if (!m || req !== coverReq) return null;
  const t = useStore.getState().track;
  if (t && t.meta.path === meta.path) {
    useStore.setState({
      track: {
        ...t,
        meta: {
          ...t.meta,
          album: t.meta.album || m.album,
          year: t.meta.year ?? m.year,
          genre: t.meta.genre || m.genre,
        },
      },
    });
  }
  return meta.hasCover ? null : m.artwork;
}

/**
 * Album art for the Discord status. Discord can only show images from a
 * public URL, so the cover is looked up on iTunes; with no match the status
 * falls back to the mono logo.
 */
async function sendDiscordArt(meta: TrackMeta) {
  const c = useStore.getState().config;
  if (!c?.discord) return;
  if (!c.discordArt) return void api.discordArt(meta.path, null).catch(() => {});
  const m = await best(meta, 0.6).catch(() => null);
  if (useStore.getState().track?.meta.path !== meta.path) return;
  const url = m?.artwork ? m.artwork.replace(/\/\d+x\d+bb\./, "/512x512bb.") : null;
  api.discordArt(meta.path, url).catch(() => {});
}

/** Theater grows out of (and shrinks back into) the now-playing cover. */
function theaterOrigin() {
  return centreOf(document.querySelector('[aria-label="Theater"]'));
}

async function loadCover(meta: TrackMeta) {
  const path = meta.path;
  const req = ++coverReq;
  let url = await preload(coverUrl(path, 1200, meta.mtime));
  const local = !!url;
  if (req !== coverReq) return;
  useStore.setState({ cover: url });
  const online = await enrich(meta, req);
  if (req !== coverReq) return;
  if (!url && online) {
    url = online;
    useStore.setState({ cover: url });
  }
  let hc: typeof coverHC = null;
  if (url) {
    try {
      hc = await accentFromImage(local ? coverUrl(path, 64, meta.mtime) : url);
    } catch {
      hc = null;
    }
  }
  if (req !== coverReq) return;
  coverHC = hc;
  refreshTheme();
}

export const useStore = create<Store>((set, get) => ({
  ready: false,
  config: null,
  player: initialPlayer,
  track: null,
  pos: 0,
  duration: 0,
  cover: null,

  crates: [],
  view: null,
  baseList: [],
  list: [],
  listLoading: false,
  selected: null,
  selection: [],
  anchor: null,
  sort: loadJSON<SortState | null>("mono.sort", null),
  userQueueEnd: null,
  shuffle: loadJSON<boolean>("mono.shuffle", false),
  unshuffled: null,
  queueOpen: false,
  eqOpen: false,
  navOpen: false,
  dropping: null,
  setNavOpen: (v) => set({ navOpen: v }),
  layout: loadJSON<"list" | "albums">("mono.layout.mode", "list"),
  setLayout: (l) => {
    saveJSON("mono.layout.mode", l);
    set({ layout: l });
  },
  smartEdit: null,
  setSmartEdit: (c) => set({ smartEdit: c }),
  keyNotation: loadJSON<KeyNotation>("mono.keyNotation", "musical"),
  queueKey: null,

  palette: false,
  settings: false,
  tagTarget: null,
  theater: false,
  toggleTheater: (v, origin) => {
    const theater = v ?? !get().theater;
    if (theater === get().theater) return;
    if (!theater && get().fullscreen) get().toggleFullscreen(false);
    zoomTransition(() => flushSync(() => set({ theater })), theater ? "in" : "out", origin ?? theaterOrigin());
  },
  fullscreen: false,
  // Fullscreen is theater mode with the window filling the screen and all
  // other chrome hidden.
  toggleFullscreen: (v) => {
    const on = v ?? !get().fullscreen;
    set({ fullscreen: on, theater: on ? true : get().theater });
    getCurrentWindow()
      .setFullscreen(on)
      .catch(() => set({ fullscreen: false }));
  },

  init: async ({ library = true } = {}) => {
    if (get().ready) return;
    set({ ready: true });
    const config = await api.getConfig();
    set({ config, player: { ...get().player, volume: config.volume, repeat: config.repeat } });
    refreshTheme();

    await on.config((c) => {
      const prev = get().config;
      set({ config: c });
      refreshTheme();
      const t = get().track;
      if (t && prev && prev.metaOnline !== c.metaOnline) loadCover(t.meta);
      if (library && t && prev && (prev.discord !== c.discord || prev.discordArt !== c.discordArt)) {
        sendDiscordArt(t.meta);
      }
    });
    await on.state((s) => {
      const end = get().userQueueEnd;
      set({ player: s, userQueueEnd: end != null && s.index != null && s.index + 1 >= end ? null : end });
    });
    await on.track((t) => {
      const prev = get().track;
      set({ track: t, duration: t.meta.duration });
      if (!prev || prev.meta.path !== t.meta.path || prev.meta.hasCover !== t.meta.hasCover) {
        loadCover(t.meta);
      }
      // Only the main window talks to Discord (the deck would duplicate it).
      if (library && (!prev || prev.meta.path !== t.meta.path)) sendDiscordArt(t.meta);
      // Keep the visible list in sync with tag edits.
      const list = get().list;
      const i = list.findIndex((m) => m.path === t.meta.path);
      if (i >= 0 && list[i] !== t.meta) {
        const next = list.slice();
        next[i] = t.meta;
        set({ list: next });
      }
    });
    await on.position((p) => set({ pos: p.pos, duration: p.duration || get().duration }));

    if (library) {
      // Files opened while Mono was already running. Explorer launches one
      // process per file when several are opened together, so arrivals close
      // together are queued rather than each replacing the last.
      let lastOpen = 0;
      await on.openFiles((paths) => {
        const now = performance.now();
        if (now - lastOpen < 1500 && get().player.queue.length) get().addToQueue(paths);
        else {
          set({ queueKey: null, userQueueEnd: null, unshuffled: null });
          api.playQueue(paths, 0);
        }
        lastOpen = now;
      });
      await on.libraryChanged((dirs) => {
        get().refreshCrates();
        const v = get().view;
        if (v?.kind === "smart") get().reloadList();
        else if (v?.kind === "crate" && dirs.some((d) => d === v.path || d.startsWith(v.path) || v.path.startsWith(d))) {
          get().reloadList();
        }
      });
      await get().refreshCrates();
      // Reopen the last view, unless it points into a folder that is no
      // longer watched (removed in Settings, or the drive changed).
      let last: View | null = null;
      try {
        last = JSON.parse(localStorage.getItem("mono.view") ?? "null");
      } catch {
        last = null;
      }
      const roots = get().config?.roots ?? [];
      const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
      const lastPath = last?.kind === "crate" ? norm(last.path) : null;
      const stillWatched =
        last?.kind === "history" ||
        (last?.kind === "smart" && !!get().config?.smartCrates?.some((c) => c.id === last!.id)) ||
        (lastPath != null && roots.some((r) => lastPath.startsWith(norm(r))));
      if (last && stillWatched) {
        await get().openView(last);
      } else if (get().crates[0]) {
        const c = get().crates[0];
        await get().openView({ kind: "crate", path: c.path, name: c.name });
      }
    }
    api.syncState();
  },

  setConfig: async (patch) => {
    const c = await api.updateConfig(patch);
    set({ config: c });
    refreshTheme();
  },

  refreshCrates: async () => {
    set({ crates: await api.crates() });
  },

  openView: async (v) => {
    set({ view: v, listLoading: true, selected: null });
    try {
      localStorage.setItem("mono.view", JSON.stringify(v));
    } catch {
      /* ignore */
    }
    const base = await fetchView(v);
    if (viewKey(get().view) !== viewKey(v)) return;
    const list = arrange(base);
    const playing = get().track?.meta.path;
    const sel = playing ? list.findIndex((m) => m.path === playing) : -1;
    const focus = sel >= 0 ? sel : list.length ? 0 : null;
    set({
      baseList: base,
      list,
      listLoading: false,
      selected: focus,
      anchor: focus,
      selection: focus != null ? [list[focus].path] : [],
    });
  },

  reloadList: async () => {
    const v = get().view;
    if (!v) return;
    const base = await fetchView(v);
    if (viewKey(get().view) !== viewKey(v)) return;
    const list = arrange(base);
    const focusPath = get().selected != null ? get().list[get().selected!]?.path : null;
    const focus = focusPath ? list.findIndex((m) => m.path === focusPath) : -1;
    const keep = new Set(list.map((m) => m.path));
    set({
      baseList: base,
      list,
      selected: focus >= 0 ? focus : get().selected,
      selection: get().selection.filter((p) => keep.has(p)),
    });
    // Keep the engine's queue aligned when the playing crate changed on disk.
    if (get().queueKey === viewKey(v)) {
      const cur = get().track?.meta.path;
      const idx = cur ? list.findIndex((m) => m.path === cur) : -1;
      if (idx >= 0) api.setQueue(list.map((m) => m.path), idx);
    }
  },

  playFromList: (i) => {
    const { list, view, shuffle } = get();
    if (!list[i]) return;
    const paths = list.map((m) => m.path);
    set({ queueKey: viewKey(view), selected: i, userQueueEnd: null });
    if (shuffle) {
      const rest = shuffled(paths.filter((_, k) => k !== i));
      set({ unshuffled: paths });
      api.playQueue([paths[i], ...rest], 0);
    } else {
      set({ unshuffled: null });
      api.playQueue(paths, i);
    }
  },

  playNext: (paths) => {
    const { player } = get();
    if (!paths.length) return;
    if (player.index == null || !player.queue.length) return void api.playQueue(paths, 0);
    const at = player.index + 1;
    const q = [...player.queue.slice(0, at), ...paths, ...player.queue.slice(at)];
    const end = get().userQueueEnd;
    set({ userQueueEnd: Math.max(end ?? at, at) + paths.length });
    get().setQueueOrder(q, player.index);
  },

  addToQueue: (paths) => {
    const { player, userQueueEnd } = get();
    if (!paths.length) return;
    if (player.index == null || !player.queue.length) return void api.playQueue(paths, 0);
    const at = Math.max(userQueueEnd ?? 0, player.index + 1);
    const q = [...player.queue.slice(0, at), ...paths, ...player.queue.slice(at)];
    set({ userQueueEnd: at + paths.length });
    get().setQueueOrder(q, player.index);
  },

  setQueueOrder: (paths, index) => {
    // Optimistic so the queue panel doesn't flicker before the engine echoes.
    set({ player: { ...get().player, queue: paths, index } });
    api.setQueue(paths, index);
  },

  toggleShuffle: () => {
    const { shuffle, player, unshuffled } = get();
    const on = !shuffle;
    saveJSON("mono.shuffle", on);
    set({ shuffle: on });
    if (player.index == null || !player.queue.length) return;
    const cur = player.queue[player.index];
    if (on) {
      const upcoming = shuffled(player.queue.slice(player.index + 1));
      set({ unshuffled: player.queue, userQueueEnd: null });
      get().setQueueOrder([...player.queue.slice(0, player.index + 1), ...upcoming], player.index);
    } else if (unshuffled) {
      const at = unshuffled.indexOf(cur);
      set({ unshuffled: null, userQueueEnd: null });
      if (at >= 0) get().setQueueOrder(unshuffled, at);
    }
  },

  setQueueOpen: (v) => set({ queueOpen: v }),
  setEqOpen: (v) => set({ eqOpen: v }),

  select: (i) => {
    const m = i != null ? get().list[i] : null;
    set({ selected: i, anchor: i, selection: m ? [m.path] : [] });
  },
  clickRow: (i, { ctrl, shift }) => {
    const { list, selection, anchor } = get();
    const m = list[i];
    if (!m) return;
    if (shift && anchor != null) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      const range = list.slice(a, b + 1).map((t) => t.path);
      set({ selected: i, selection: ctrl ? [...new Set([...selection, ...range])] : range });
    } else if (ctrl) {
      const has = selection.includes(m.path);
      set({
        selected: i,
        anchor: i,
        selection: has ? selection.filter((p) => p !== m.path) : [...selection, m.path],
      });
    } else {
      set({ selected: i, anchor: i, selection: [m.path] });
    }
  },
  extendTo: (i) => {
    const { list, anchor } = get();
    if (!list[i]) return;
    const a = anchor ?? i;
    const [lo, hi] = a < i ? [a, i] : [i, a];
    set({ selected: i, anchor: a, selection: list.slice(lo, hi + 1).map((t) => t.path) });
  },
  selectAll: () => set({ selection: get().list.map((m) => m.path), anchor: 0 }),
  selectedTracks: () => {
    const sel = new Set(get().selection);
    return get().list.filter((m) => sel.has(m.path));
  },
  setSort: (col) => {
    const cur = get().sort;
    const next: SortState | null =
      !cur || cur.col !== col ? { col, dir: 1 } : cur.dir === 1 ? { col, dir: -1 } : null;
    saveJSON("mono.sort", next);
    set({ sort: next });
    rearrange();
  },
  setKeyNotation: (n) => {
    saveJSON("mono.keyNotation", n);
    set({ keyNotation: n });
    if (get().sort?.col === "key") rearrange();
  },
  setPalette: (v) => set({ palette: v }),
  setSettings: (v) => set({ settings: v }),
  openTags: (paths) =>
    set({ tagTarget: paths == null ? null : Array.isArray(paths) ? (paths.length ? paths : null) : [paths] }),

  toggleViz: () => {
    const c = get().config;
    if (c) get().setConfig({ vizOpen: !c.vizOpen });
  },
  cycleRepeat: () => {
    const order: Repeat[] = ["off", "all", "one"];
    const cur = get().player.repeat;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    set({ player: { ...get().player, repeat: next } });
    api.setRepeat(next);
  },
  setA: () => {
    const { player, pos } = get();
    if (player.loopA != null) return void api.setLoop(null, null);
    api.setLoop(pos, null);
  },
  setB: () => {
    const { player, pos } = get();
    if (player.loopB != null) return void api.setLoop(player.loopA, null);
    if (player.loopA == null) return void api.setLoop(0, pos);
    if (pos > player.loopA + 0.05) api.setLoop(player.loopA, pos);
  },
  clearLoop: () => void api.setLoop(null, null),
}));
