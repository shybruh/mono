import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";

const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
const inside = (path: string, root: string) => {
  const p = norm(path);
  const r = norm(root);
  return p === r || p.startsWith(r + "\\") || p.startsWith(r + "/");
};

/**
 * Folders dropped on the window become crates (or open, if already in the
 * library); audio files dropped on it play.
 */
async function handleDrop(paths: string[]) {
  const { folders, audio } = await api.sortDropped(paths);
  const s = useStore.getState();
  if (folders.length) {
    const roots = s.config?.roots ?? [];
    const fresh = folders.filter((f) => !roots.some((r) => inside(f, r)));
    if (fresh.length) await s.setConfig({ roots: [...roots, ...fresh] });
    await useStore.getState().refreshCrates();
    const dir = folders[folders.length - 1];
    await useStore.getState().openView({ kind: "crate", path: dir, name: dir.split(/[\\/]/).pop() || dir });
  } else if (audio.length) {
    useStore.setState({ queueKey: null, userQueueEnd: null, unshuffled: null });
    api.playQueue(audio, 0);
  }
}

export function useFileDrop() {
  useEffect(() => {
    let live = true;
    let un: (() => void) | undefined;
    // Bumped on every enter/leave/drop so a slow lookup can't revive an old drag.
    let drag = 0;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter") {
          const id = ++drag;
          api
            .sortDropped(p.paths)
            .then(({ folders, audio }) => {
              if (id === drag) useStore.setState({ dropping: folders.length ? "folder" : audio.length ? "audio" : null });
            })
            .catch(() => {});
        } else if (p.type === "leave") {
          drag++;
          useStore.setState({ dropping: null });
        } else if (p.type === "drop") {
          drag++;
          useStore.setState({ dropping: null });
          if (p.paths.length) handleDrop(p.paths).catch(() => {});
        }
      })
      .then((f) => {
        if (live) un = f;
        else f();
      })
      .catch(() => {});
    return () => {
      live = false;
      un?.();
    };
  }, []);
}
