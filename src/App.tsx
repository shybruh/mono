import { lazy, Suspense, useEffect, useState } from "react";
import { FolderPlus, Play } from "lucide-react";
import { DropZone } from "@/components/DropZone";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TitleBar } from "@/components/TitleBar";
import { Sidebar, addFolder } from "@/components/Sidebar";
import { NowPlaying } from "@/components/NowPlaying";
import { TrackList } from "@/components/TrackList";
import { Transport } from "@/components/Transport";
import { VisualizerPanel } from "@/components/VisualizerPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { QueuePanel } from "@/components/QueuePanel";
import { startAutoCheck } from "@/lib/updater";
import { useFileDrop } from "@/hooks/useFileDrop";
import { useCompact } from "@/hooks/useCompact";
import { MobileApp } from "@/components/MobileApp";
import { isAndroidApp } from "@/lib/platform";
import { useAndroidMedia } from "@/hooks/useAndroidMedia";

// Screens that aren't on screen at launch load in their own chunks, fetched
// while the app is idle so opening them later is still instant.
const chunks = {
  TagDrawer: () => import("@/components/TagDrawer").then((m) => ({ default: m.TagDrawer })),
  SettingsDialog: () => import("@/components/SettingsDialog").then((m) => ({ default: m.SettingsDialog })),
  Theater: () => import("@/components/Theater").then((m) => ({ default: m.Theater })),
  ParametricEq: () => import("@/components/ParametricEq").then((m) => ({ default: m.ParametricEq })),
  SmartCrateDialog: () => import("@/components/SmartCrateDialog").then((m) => ({ default: m.SmartCrateDialog })),
  AlbumGrid: () => import("@/components/AlbumGrid").then((m) => ({ default: m.AlbumGrid })),
};
const TagDrawer = lazy(chunks.TagDrawer);
const SettingsDialog = lazy(chunks.SettingsDialog);
const Theater = lazy(chunks.Theater);
const ParametricEq = lazy(chunks.ParametricEq);
const SmartCrateDialog = lazy(chunks.SmartCrateDialog);
const AlbumGrid = lazy(chunks.AlbumGrid);

function preloadChunks() {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ?? ((cb) => setTimeout(cb, 1500));
  idle(() => Object.values(chunks).forEach((c) => c().catch(() => {})));
}

/** Mounts its children the first time `when` is true, then keeps them. */
function Deferred({ when, children }: { when: boolean; children: React.ReactNode }) {
  const [seen, setSeen] = useState(when);
  useEffect(() => {
    if (when) setSeen(true);
  }, [when]);
  return seen || when ? <Suspense fallback={null}>{children}</Suspense> : null;
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.setPalette(!s.palette);
        return;
      }
      if (ctrl && e.key === ",") {
        e.preventDefault();
        s.setSettings(true);
        return;
      }
      if (isTyping(e) || s.palette || s.settings || s.tagTarget || s.queueOpen || s.eqOpen || s.smartEdit) return;
      if (ctrl && e.key.toLowerCase() === "a") {
        e.preventDefault();
        s.selectAll();
        return;
      }
      if (ctrl || e.altKey) return;

      const { list, selected } = s;
      switch (e.key) {
        case "/":
          e.preventDefault();
          s.setPalette(true);
          break;
        case " ":
          e.preventDefault();
          api.toggle();
          break;
        case "ArrowLeft":
          e.preventDefault();
          api.seekRelative(e.shiftKey ? -30 : -5);
          break;
        case "ArrowRight":
          e.preventDefault();
          api.seekRelative(e.shiftKey ? 30 : 5);
          break;
        case "ArrowDown": {
          e.preventDefault();
          if (!list.length) break;
          const i = Math.min(list.length - 1, (selected ?? -1) + 1);
          if (e.shiftKey) s.extendTo(i);
          else s.select(i);
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          if (!list.length) break;
          const i = Math.max(0, (selected ?? 1) - 1);
          if (e.shiftKey) s.extendTo(i);
          else s.select(i);
          break;
        }
        case "q":
        case "Q":
          s.setQueueOpen(true);
          break;
        case "e":
        case "E":
          s.setEqOpen(true);
          break;
        case "s":
        case "S":
          s.toggleShuffle();
          break;
        case "Home":
          if (list.length) s.select(0);
          break;
        case "End":
          if (list.length) s.select(list.length - 1);
          break;
        case "Enter":
          if (selected != null) s.playFromList(selected);
          break;
        case "[":
          s.setA();
          break;
        case "]":
          s.setB();
          break;
        case "\\":
          s.clearLoop();
          break;
        case "0":
          api.setSpeed(1);
          api.setPitch(0);
          break;
        case "n":
        case "N":
          api.next();
          break;
        case "p":
        case "P":
          api.prev();
          break;
        case "r":
        case "R":
          s.cycleRepeat();
          break;
        case "v":
        case "V":
          s.toggleViz();
          break;
        case "f":
        case "F":
          s.toggleTheater();
          break;
        case "Escape":
          if (s.fullscreen) s.toggleFullscreen(false);
          else if (s.theater) s.toggleTheater(false);
          break;
        case "F11":
          e.preventDefault();
          s.toggleFullscreen();
          break;
        case "m":
        case "M":
          api.openDeck();
          break;
        case "t":
        case "T": {
          const sel = s.selection;
          if (sel.length > 1) s.openTags(sel);
          else {
            const p = (selected != null && list[selected]?.path) || s.track?.meta.path;
            if (p) s.openTags(p);
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  const init = useStore((s) => s.init);
  const hasRoots = useStore((s) => (s.config ? s.config.roots.length > 0 : true));
  const theater = useStore((s) => s.theater);
  const tagOpen = useStore((s) => !!s.tagTarget?.length);
  const eqOpen = useStore((s) => s.eqOpen);
  const smartOpen = useStore((s) => !!s.smartEdit);
  const settingsOpen = useStore((s) => s.settings);
  useEffect(preloadChunks, []);
  const layout = useStore((s) => s.layout);
  const fullscreen = useStore((s) => s.fullscreen);
  const autoUpdate = useStore((s) => s.config?.autoUpdate);
  useEffect(() => {
    init();
  }, [init]);
  useEffect(() => {
    // The Android app has no self-updater.
    if (autoUpdate !== undefined && !isAndroidApp) startAutoCheck(autoUpdate);
  }, [autoUpdate]);
  useShortcuts();
  useFileDrop();
  useAndroidMedia();
  const dropping = useStore((s) => s.dropping);
  const compact = useCompact();

  return (
    <TooltipProvider delayDuration={400}>
      {compact ? (
        <MobileApp />
      ) : fullscreen ? (
        <div className="flex h-full flex-col">
          <Suspense fallback={null}>
            <Theater fullscreen />
          </Suspense>
        </div>
      ) : (
      <div className="flex h-full flex-col">
        <TitleBar />
        {theater ? (
          <Suspense fallback={null}>
            <Theater />
          </Suspense>
        ) : (
          <div className="flex min-h-0 flex-1">
            <Sidebar />
            <main className="relative flex min-w-0 flex-1 flex-col">
              <DropZone on={dropping === "audio"} icon={Play} filled />
              <NowPlaying />
              {hasRoots ? (
                layout === "albums" ? (
                  <Suspense fallback={null}>
                    <AlbumGrid />
                  </Suspense>
                ) : (
                  <TrackList />
                )
              ) : (
                <div className="flex flex-1 items-center justify-center">
                  <button
                    onClick={addFolder}
                    className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-2.5 text-muted-foreground hover:border-brand hover:text-foreground"
                  >
                    <FolderPlus className="size-4" /> Add folder
                  </button>
                </div>
              )}
            </main>
          </div>
        )}
        <VisualizerPanel />
        <Transport />
      </div>
      )}
      <CommandPalette />
      <Deferred when={tagOpen}>
        <TagDrawer />
      </Deferred>
      <QueuePanel />
      <Deferred when={eqOpen}>
        <ParametricEq />
      </Deferred>
      <Deferred when={smartOpen}>
        <SmartCrateDialog />
      </Deferred>
      <Deferred when={settingsOpen}>
        <SettingsDialog />
      </Deferred>
    </TooltipProvider>
  );
}
