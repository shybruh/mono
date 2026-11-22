import { create } from "zustand";
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

export type View =
  | { kind: "crate"; path: string; name: string }
  | { kind: "history"; days: number; name: string };

export const viewKey = (v: View | null) =>
  !v ? "" : v.kind === "crate" ? `crate:${v.path}` : `history:${v.days}`;

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
  list: TrackMeta[];
  listLoading: boolean;
  selected: number | null;
  queueKey: string | null;

  palette: boolean;
  settings: boolean;
  tagTarget: string | null;
  theater: boolean;
  toggleTheater: (v?: boolean) => void;
  fullscreen: boolean;
  toggleFullscreen: (v?: boolean) => void;

  init: (opts?: { library?: boolean }) => Promise<void>;
  setConfig: (patch: Partial<Config>) => Promise<void>;
  refreshCrates: () => Promise<void>;
  openView: (v: View) => Promise<void>;
  reloadList: () => Promise<void>;
  playFromList: (i: number) => void;
  select: (i: number | null) => void;
  setPalette: (v: boolean) => void;
  setSettings: (v: boolean) => void;
  openTags: (path: string | null) => void;

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

async function loadCover(meta: TrackMeta) {
  const path = meta.path;
  const req = ++coverReq;
  let url = await api.cover(path).catch(() => null);
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
      hc = await accentFromImage(url);
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
  list: [],
  listLoading: false,
  selected: null,
  queueKey: null,

  palette: false,
  settings: false,
  tagTarget: null,
  theater: false,
  toggleTheater: (v) => {
    const theater = v ?? !get().theater;
    if (!theater && get().fullscreen) get().toggleFullscreen(false);
    set({ theater });
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
    });
    await on.state((s) => set({ player: s }));
    await on.track((t) => {
      const prev = get().track;
      set({ track: t, duration: t.meta.duration });
      if (!prev || prev.meta.path !== t.meta.path || prev.meta.hasCover !== t.meta.hasCover) {
        loadCover(t.meta);
      }
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
      await on.libraryChanged((dirs) => {
        get().refreshCrates();
        const v = get().view;
        if (v?.kind === "crate" && dirs.some((d) => d === v.path || d.startsWith(v.path) || v.path.startsWith(d))) {
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
        last?.kind === "history" || (lastPath != null && roots.some((r) => lastPath.startsWith(norm(r))));
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
    const list = v.kind === "crate" ? await api.tracks(v.path) : await api.historyTracks(v.days);
    if (viewKey(get().view) !== viewKey(v)) return;
    const playing = get().track?.meta.path;
    const sel = playing ? list.findIndex((m) => m.path === playing) : -1;
    set({ list, listLoading: false, selected: sel >= 0 ? sel : list.length ? 0 : null });
  },

  reloadList: async () => {
    const v = get().view;
    if (!v) return;
    const list = v.kind === "crate" ? await api.tracks(v.path) : await api.historyTracks(v.days);
    if (viewKey(get().view) !== viewKey(v)) return;
    set({ list });
    // Keep the engine's queue aligned when the playing crate changed on disk.
    if (get().queueKey === viewKey(v)) {
      const cur = get().track?.meta.path;
      const idx = cur ? list.findIndex((m) => m.path === cur) : -1;
      if (idx >= 0) api.setQueue(list.map((m) => m.path), idx);
    }
  },

  playFromList: (i) => {
    const { list, view } = get();
    if (!list[i]) return;
    set({ queueKey: viewKey(view), selected: i });
    api.playQueue(
      list.map((m) => m.path),
      i,
    );
  },

  select: (i) => set({ selected: i }),
  setPalette: (v) => set({ palette: v }),
  setSettings: (v) => set({ settings: v }),
  openTags: (path) => set({ tagTarget: path }),

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
