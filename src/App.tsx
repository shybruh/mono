import { useEffect } from "react";
import { FolderPlus } from "lucide-react";
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
import { TagDrawer } from "@/components/TagDrawer";
import { SettingsDialog } from "@/components/SettingsDialog";
import { Theater } from "@/components/Theater";

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
      if (isTyping(e) || s.palette || s.settings || s.tagTarget) return;
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
        case "ArrowDown":
          e.preventDefault();
          if (list.length) s.select(Math.min(list.length - 1, (selected ?? -1) + 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          if (list.length) s.select(Math.max(0, (selected ?? 1) - 1));
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
          const p = (selected != null && list[selected]?.path) || s.track?.meta.path;
          if (p) s.openTags(p);
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
  const fullscreen = useStore((s) => s.fullscreen);
  useEffect(() => {
    init();
  }, [init]);
  useShortcuts();

  return (
    <TooltipProvider delayDuration={400}>
      {fullscreen ? (
        <div className="flex h-full flex-col">
          <Theater fullscreen />
        </div>
      ) : (
      <div className="flex h-full flex-col">
        <TitleBar />
        {theater ? (
          <Theater />
        ) : (
          <div className="flex min-h-0 flex-1">
            <Sidebar />
            <main className="flex min-w-0 flex-1 flex-col">
              <NowPlaying />
              {hasRoots ? (
                <TrackList />
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
      <TagDrawer />
      <SettingsDialog />
    </TooltipProvider>
  );
}
