import { create } from "zustand";
import { api } from "./api";
import { useStore } from "./store";

// Sleep timer: pause after N minutes or at the end of the current track,
// fading out over the last few seconds and restoring the volume afterwards.

const FADE_SECONDS = 10;

type Mode = { kind: "minutes"; endsAt: number } | { kind: "track"; path: string };

interface SleepState {
  mode: Mode | null;
  /** Seconds left, for the button label. */
  remaining: number | null;
}

export const useSleep = create<SleepState>(() => ({ mode: null, remaining: null }));

let timer: number | undefined;
let fadeFrom: number | null = null;

function restoreVolume() {
  if (fadeFrom != null) {
    api.setVolume(fadeFrom);
    fadeFrom = null;
  }
}

function tick() {
  const { mode } = useSleep.getState();
  if (!mode) return;
  const s = useStore.getState();
  let left: number;
  if (mode.kind === "minutes") {
    left = (mode.endsAt - Date.now()) / 1000;
  } else {
    // Track changed (skipped or gapless): stop now rather than play on.
    if (s.track?.meta.path !== mode.path) left = 0;
    else left = Math.max(0, s.duration - s.pos) / Math.max(0.25, s.player.speed);
  }
  useSleep.setState({ remaining: Math.max(0, Math.round(left)) });

  if (!s.player.playing) return;
  if (left <= 0) {
    api.pause();
    // Let the 4 ms pause ramp finish before putting the volume back.
    window.setTimeout(restoreVolume, 300);
    cancelSleep(false);
    return;
  }
  if (left <= FADE_SECONDS) {
    if (fadeFrom == null) fadeFrom = s.player.volume;
    api.setVolume(fadeFrom * (left / FADE_SECONDS));
  }
}

export function startSleep(choice: number | "track") {
  cancelSleep();
  const s = useStore.getState();
  const mode: Mode =
    choice === "track"
      ? { kind: "track", path: s.track?.meta.path ?? "" }
      : { kind: "minutes", endsAt: Date.now() + choice * 60_000 };
  useSleep.setState({ mode });
  timer = window.setInterval(tick, 250);
  tick();
}

export function cancelSleep(restore = true) {
  window.clearInterval(timer);
  timer = undefined;
  if (restore) restoreVolume();
  useSleep.setState({ mode: null, remaining: null });
}

export function fmtRemaining(sec: number | null): string {
  if (sec == null) return "";
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}`;
  if (sec >= 60) return `${Math.ceil(sec / 60)}m`;
  return `${sec}s`;
}
