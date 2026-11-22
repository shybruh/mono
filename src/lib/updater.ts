import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Signed updates from GitHub Releases (see .github/workflows/release.yml).
// The endpoint and public key live in tauri.conf.json → plugins.updater.

type Status = "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error";

interface UpdaterState {
  status: Status;
  update: Update | null;
  /** 0..1 while downloading. */
  progress: number;
  error: string | null;
  checkedAt: number | null;
}

export const useUpdater = create<UpdaterState>(() => ({
  status: "idle",
  update: null,
  progress: 0,
  error: null,
  checkedAt: null,
}));

export async function checkForUpdate(): Promise<Update | null> {
  const s = useUpdater.getState();
  if (s.status === "checking" || s.status === "downloading" || s.status === "installing") return s.update;
  useUpdater.setState({ status: "checking", error: null });
  try {
    const update = await check();
    useUpdater.setState({
      status: update ? "available" : "current",
      update,
      checkedAt: Date.now(),
    });
    return update;
  } catch (e) {
    useUpdater.setState({ status: "error", error: String(e), checkedAt: Date.now() });
    return null;
  }
}

export async function installUpdate() {
  const { update } = useUpdater.getState();
  if (!update) return;
  let total = 0;
  let got = 0;
  useUpdater.setState({ status: "downloading", progress: 0, error: null });
  try {
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        if (total > 0) useUpdater.setState({ progress: Math.min(1, got / total) });
      } else if (ev.event === "Finished") useUpdater.setState({ status: "installing", progress: 1 });
    });
    await relaunch();
  } catch (e) {
    useUpdater.setState({ status: "error", error: String(e) });
  }
}

const SIX_HOURS = 6 * 60 * 60 * 1000;
let timer: number | undefined;

/** Background checks: shortly after launch, then every six hours. */
export function startAutoCheck(enabled: boolean) {
  window.clearTimeout(timer);
  window.clearInterval(timer);
  if (!enabled || import.meta.env.DEV) return;
  timer = window.setTimeout(() => {
    checkForUpdate();
    timer = window.setInterval(checkForUpdate, SIX_HOURS);
  }, 8000);
}
