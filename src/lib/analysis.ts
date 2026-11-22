import { create } from "zustand";
import { api, type TrackMeta } from "./api";
import { useStore } from "./store";

// BPM / key analysis for a batch of tracks. Two run at a time; each result
// is written to the file's tags by the backend and patched into the list.

interface AnalysisState {
  running: boolean;
  done: number;
  total: number;
  cancel: () => void;
}

let cancelled = false;

export const useAnalysis = create<AnalysisState>(() => ({
  running: false,
  done: 0,
  total: 0,
  cancel: () => {
    cancelled = true;
  },
}));

function patch(meta: TrackMeta) {
  const s = useStore.getState();
  const swap = (l: TrackMeta[]) => l.map((m) => (m.path === meta.path ? meta : m));
  useStore.setState({ baseList: swap(s.baseList), list: swap(s.list) });
}

export async function analyse(tracks: TrackMeta[]) {
  if (useAnalysis.getState().running || !tracks.length) return;
  cancelled = false;
  useAnalysis.setState({ running: true, done: 0, total: tracks.length });
  const queue = [...tracks];
  const worker = async () => {
    while (queue.length && !cancelled) {
      const t = queue.shift()!;
      try {
        patch(await api.analyseTrack(t.path));
      } catch {
        /* unreadable or too short: skip */
      }
      useAnalysis.setState((s) => ({ done: s.done + 1 }));
    }
  };
  await Promise.all([worker(), worker()]);
  useAnalysis.setState({ running: false });
}
