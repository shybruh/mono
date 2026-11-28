/**
 * The Android app, as opposed to the website opened on an Android phone:
 * only the app has Tauri's bridge.
 */
export const isAndroidApp =
  typeof window !== "undefined" && /Android/i.test(navigator.userAgent) && "__TAURI_INTERNALS__" in window;

declare global {
  interface Window {
    /** Android app: the system folder picker (answers with a `mono:folder` event). */
    MonoFolders?: { pick(): void; canEdit(): boolean; askEdit(): void };
  }
}

/**
 * Android app: changing music files (tags, covers, lyrics files) needs "All
 * files access". Returns whether it's granted; if not, opens the system page
 * that grants it.
 */
export function ensureFileAccess(): boolean {
  const bridge = window.MonoFolders;
  if (!bridge || bridge.canEdit()) return true;
  bridge.askEdit();
  return false;
}

/**
 * Android app: opens the system folder picker. Resolves to the folder's path,
 * or null if nothing was picked or the folder isn't on the phone's storage.
 */
export function pickAndroidFolder(): Promise<string | null> {
  const bridge = window.MonoFolders;
  if (!bridge) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (e: Event) => {
      window.removeEventListener("mono:folder", done);
      resolve((e as CustomEvent<string>).detail || null);
    };
    window.addEventListener("mono:folder", done);
    bridge.pick();
  });
}
