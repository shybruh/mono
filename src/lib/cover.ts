import { convertFileSrc } from "@tauri-apps/api/core";

const base = convertFileSrc("", "cover");

/**
 * URL of a track's cover on the `cover://` protocol. `size` > 0 returns a
 * cached JPEG thumbnail; `v` busts the webview cache after the file changes.
 */
export function coverUrl(path: string, size = 0, v?: number | null): string {
  return `${base}${encodeURIComponent(path)}?s=${size}${v ? `&v=${v}` : ""}`;
}

/** Resolves with the URL once the image has loaded, or null if there is none. */
export function preload(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(url);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
