import { useSyncExternalStore } from "react";

// Phone-width layout. The desktop window can't get this narrow (its minimum
// width is 760 px), so the desktop app never switches to it.
const query = "(max-width: 639px)";
const mq = typeof window !== "undefined" ? window.matchMedia(query) : null;

const subscribe = (cb: () => void) => {
  mq?.addEventListener("change", cb);
  return () => mq?.removeEventListener("change", cb);
};

export const isCompact = () => !!mq?.matches;

export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, isCompact, () => false);
}
