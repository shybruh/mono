import { useEffect, useMemo, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Folder, ListMusic, Music2, CornerDownLeft } from "lucide-react";
import { api, on, type CrateNode, type IndexEntry } from "@/lib/api";
import { useStore } from "@/lib/store";
import { multiScore } from "@/lib/fuzzy";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { addFolder } from "./Sidebar";
import { newSmartCrate } from "./SmartCrateDialog";
import { analyse } from "@/lib/analysis";
import { basename } from "@/lib/utils";

interface Action {
  id: string;
  label: string;
  keys?: string;
  run: () => void;
}

function actions(): Action[] {
  const s = useStore.getState();
  const tagPath = (s.selected != null && s.list[s.selected]?.path) || s.track?.meta.path;
  return [
    { id: "toggle", label: s.player.playing ? "Pause" : "Play", keys: "Space", run: () => api.toggle() },
    { id: "next", label: "Next track", keys: "N", run: () => api.next() },
    { id: "prev", label: "Previous track", keys: "P", run: () => api.prev() },
    { id: "a", label: "Set loop A", keys: "[", run: s.setA },
    { id: "b", label: "Set loop B", keys: "]", run: s.setB },
    { id: "clear", label: "Clear loop", keys: "\\", run: s.clearLoop },
    { id: "speed", label: "Reset tempo and pitch", keys: "0", run: () => (api.setSpeed(1), api.setPitch(0)) },
    { id: "repeat", label: `Repeat: ${s.player.repeat} → next`, keys: "R", run: s.cycleRepeat },
    { id: "viz", label: "Toggle visualiser", keys: "V", run: s.toggleViz },
    { id: "theater", label: "Theater and lyrics", keys: "F", run: () => s.toggleTheater() },
    { id: "fullscreen", label: "Fullscreen", keys: "F11", run: () => s.toggleFullscreen() },
    { id: "queue", label: "Up next", keys: "Q", run: () => s.setQueueOpen(true) },
    { id: "shuffle", label: s.shuffle ? "Shuffle off" : "Shuffle on", keys: "S", run: () => s.toggleShuffle() },
    {
      id: "layout",
      label: s.layout === "albums" ? "Show track list" : "Show album grid",
      run: () => s.setLayout(s.layout === "albums" ? "list" : "albums"),
    },
    { id: "smart", label: "New smart crate", run: () => s.setSmartEdit(newSmartCrate()) },
    { id: "analyse", label: "Analyse BPM and key for this crate", run: () => analyse(s.list.filter((m) => !m.bpm || !m.key)) },
    { id: "selectall", label: "Select all tracks", keys: "Ctrl A", run: () => s.selectAll() },
    { id: "deck", label: "Micro-deck", keys: "M", run: () => api.openDeck() },
    { id: "tags", label: "Edit tags", keys: "T", run: () => tagPath && s.openTags(tagPath) },
    { id: "folder", label: "Add folder", run: addFolder },
    { id: "settings", label: "Settings", keys: "Ctrl ,", run: () => s.setSettings(true) },
  ];
}

function flatten(nodes: CrateNode[], out: CrateNode[] = []) {
  for (const n of nodes) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

const itemCls =
  "flex h-9 cursor-default items-center gap-2.5 rounded-md px-2 text-[13px] text-muted-foreground data-[selected=true]:bg-accent data-[selected=true]:text-foreground [&_svg]:size-4 [&_svg]:shrink-0";

export function CommandPalette() {
  const open = useStore((s) => s.palette);
  const crates = useStore((s) => s.crates);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState<IndexEntry[]>([]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    api.libraryIndex().then(setIndex).catch(() => {});
  }, [open]);

  useEffect(() => {
    const un = on.libraryIndexed(() => {
      if (useStore.getState().palette) api.libraryIndex().then(setIndex);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const flat = useMemo(() => flatten(crates), [crates]);

  const results = useMemo(() => {
    const acts = actions();
    if (!q.trim()) {
      return { acts: acts.slice(0, 8), crates: flat.slice(0, 8), tracks: [] as IndexEntry[] };
    }
    const rank = <T,>(items: T[], fields: (x: T) => (string | null | undefined)[], limit: number) =>
      items
        .map((x) => [x, multiScore(q, fields(x))] as const)
        .filter(([, s]) => s >= 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([x]) => x);
    return {
      acts: rank(acts, (a) => [a.label], 6),
      crates: rank(flat, (c) => [c.name, c.path], 8),
      tracks: rank(index, (t) => [t.title, t.artist, t.album, basename(t.path)], 50),
    };
  }, [q, flat, index]);

  const close = () => useStore.getState().setPalette(false);

  const playEntry = async (t: IndexEntry) => {
    close();
    const s = useStore.getState();
    await s.openView({ kind: "crate", path: t.dir, name: basename(t.dir) });
    const i = useStore.getState().list.findIndex((m) => m.path === t.path);
    if (i >= 0) useStore.getState().playFromList(i);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => useStore.getState().setPalette(v)}>
      <DialogContent showCloseButton={false} className="top-[22%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Search tracks, crates and commands</DialogDescription>
        <CommandPrimitive shouldFilter={false} loop className="flex flex-col">
          <div className="flex items-center border-b px-3">
            <CommandPrimitive.Input
              autoFocus
              value={q}
              onValueChange={setQ}
              placeholder="Tracks, crates, commands"
              className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <span className="font-mono text-[11px] text-muted-foreground">Esc</span>
          </div>
          <CommandPrimitive.List className="max-h-[min(60vh,440px)] overflow-y-auto p-1.5">
            <CommandPrimitive.Empty className="py-8 text-center text-sm text-muted-foreground">
              No matches
            </CommandPrimitive.Empty>
            {results.tracks.length > 0 && (
              <CommandPrimitive.Group heading="Tracks" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground/60">
                {results.tracks.map((t) => (
                  <CommandPrimitive.Item key={t.path} value={`t:${t.path}`} onSelect={() => playEntry(t)} className={itemCls}>
                    <Music2 />
                    <span className="truncate text-foreground">{t.title}</span>
                    <span className="truncate">{t.artist}</span>
                    <span className="ml-auto truncate font-mono text-[11px] opacity-60">{basename(t.dir)}</span>
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.Group>
            )}
            {results.acts.length > 0 && (
              <CommandPrimitive.Group heading="Commands" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground/60">
                {results.acts.map((a) => (
                  <CommandPrimitive.Item
                    key={a.id}
                    value={`a:${a.id}`}
                    onSelect={() => {
                      close();
                      a.run();
                    }}
                    className={itemCls}
                  >
                    <CornerDownLeft />
                    <span className="text-foreground">{a.label}</span>
                    {a.keys && <span className="ml-auto font-mono text-[11px] opacity-60">{a.keys}</span>}
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.Group>
            )}
            {results.crates.length > 0 && (
              <CommandPrimitive.Group heading="Crates" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground/60">
                {results.crates.map((c) => (
                  <CommandPrimitive.Item
                    key={c.path}
                    value={`c:${c.path}`}
                    onSelect={() => {
                      close();
                      useStore.getState().openView({ kind: "crate", path: c.path, name: c.name });
                    }}
                    className={itemCls}
                  >
                    {c.kind === "playlist" ? <ListMusic /> : <Folder />}
                    <span className="text-foreground">{c.name}</span>
                    <span className="ml-auto truncate font-mono text-[11px] opacity-60">{c.path}</span>
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.Group>
            )}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}
