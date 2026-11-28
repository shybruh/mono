import { useEffect } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";

/** `window.MonoAndroid`, added by the Android app's activity. */
interface AndroidBridge {
  update(
    path: string,
    title: string,
    artist: string,
    album: string,
    playing: boolean,
    durationMs: number,
    posMs: number,
  ): void;
}

declare global {
  interface Window {
    MonoAndroid?: AndroidBridge;
  }
}

/**
 * Android app: reports the track and play state to the playback service (the
 * notification, lock screen and background playback), and carries out the
 * buttons pressed there. Does nothing elsewhere.
 */
export function useAndroidMedia() {
  useEffect(() => {
    const bridge = window.MonoAndroid;
    if (!bridge) return;

    // Position is sent only on changes the system can't extrapolate: a new
    // track, play/pause, or a jump (seek, loop) away from where it expected.
    let sentPos = 0;
    let sentAt = 0;
    const push = () => {
      const s = useStore.getState();
      const m = s.track?.meta;
      if (!m) return;
      bridge.update(
        m.path,
        m.title,
        m.artist ?? "",
        m.album ?? "",
        s.player.playing,
        Math.round(s.duration * 1000),
        Math.round(s.pos * 1000),
      );
      sentPos = s.pos;
      sentAt = performance.now();
    };

    const unsub = useStore.subscribe((s, prev) => {
      if (!s.track) return;
      const changed =
        s.track.meta.path !== prev.track?.meta.path ||
        s.player.playing !== prev.player.playing ||
        s.duration !== prev.duration;
      const expected = sentPos + (s.player.playing ? ((performance.now() - sentAt) / 1000) * s.player.speed : 0);
      if (changed || Math.abs(s.pos - expected) > 1.5) push();
    });

    const onMedia = (e: Event) => {
      const { action, value } = (e as CustomEvent<{ action: string; value: number }>).detail;
      if (action === "play") api.play();
      else if (action === "pause") api.pause();
      else if (action === "next") api.next();
      else if (action === "prev") api.prev();
      else if (action === "seek") api.seek(value / 1000);
    };
    window.addEventListener("mono:media", onMedia);

    // In the background or with the screen off, the engine only needs to
    // report the position now and then.
    const onVisibility = () => api.setUiHidden(document.hidden).catch(() => {});
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();

    push();
    return () => {
      unsub();
      window.removeEventListener("mono:media", onMedia);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
