import { create } from "zustand";
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

async function loadCover(path: string) {
  const req = ++coverReq;
  const url = await api.cover(path).catch(() => null);
  if (req !== coverReq) return;
  useStore.setState({ cover: url });
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
  toggleTheater: (v) => set({ theater: v ?? !get().theater }),

  init: async ({ library = true } = {}) => {
    if (get().ready) return;
    set({ ready: true });
    const config = await api.getConfig();
    set({ config, player: { ...get().player, volume: config.volume, repeat: config.repeat } });
    refreshTheme();

    await on.config((c) => {
      set({ config: c });
      refreshTheme();
    });
    await on.state((s) => set({ player: s }));
    await on.track((t) => {
      const prev = get().track;
      set({ track: t, duration: t.meta.duration });
      if (!prev || prev.meta.path !== t.meta.path || prev.meta.hasCover !== t.meta.hasCover) {
        loadCover(t.meta.path);
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
      const last = localStorage.getItem("mono.view");
      if (last) {
        try {
          await get().openView(JSON.parse(last));
        } catch {
          /* stale */
        }
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
