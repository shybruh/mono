import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronRight, Folder, FolderOpen, FolderPlus, History, ListFilter, ListMusic, Plus } from "lucide-react";
import { newSmartCrate } from "@/lib/smartCrate";
import type { CrateNode } from "@/lib/api";
import { EMPTY, useStore, viewKey, type View } from "@/lib/store";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { ResizeHandle, startDrag, useSizes } from "@/hooks/useDragSize";
import { useCompact } from "@/hooks/useCompact";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

export async function addFolder() {
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir !== "string") return;
  const { config, setConfig, openView } = useStore.getState();
  const roots = config?.roots ?? [];
  if (!roots.includes(dir)) await setConfig({ roots: [...roots, dir] });
  await useStore.getState().refreshCrates();
  const name = dir.split(/[\\/]/).pop() || dir;
  await openView({ kind: "crate", path: dir, name });
}

function Row({
  node,
  depth,
  isRoot,
}: {
  node: CrateNode;
  depth: number;
  isRoot: boolean;
}) {
  const current = useStore((s) => viewKey(s.view));
  const playingKey = useStore((s) => s.queueKey);
  const key = `crate:${node.path}`;
  const active = current === key;
  const hasKids = node.children.length > 0;
  const [open, setOpen] = useState(isRoot || current.startsWith(key));
  const Icon = node.kind === "playlist" ? ListMusic : active ? FolderOpen : Folder;

  const row = (
    <button
      onClick={() => useStore.getState().openView({ kind: "crate", path: node.path, name: node.name })}
      onDoubleClick={() => hasKids && setOpen(!open)}
      className={cn(
        "group flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
      style={{ paddingLeft: 4 + depth * 12 }}
    >
      <span
        role="button"
        aria-label={open ? "Collapse" : "Expand"}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className={cn("flex size-4 shrink-0 items-center justify-center", !hasKids && "invisible")}
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </span>
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{node.name}</span>
      {playingKey === key && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-brand" />}
    </button>
  );

  return (
    <>
      {isRoot ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              onSelect={() => {
                const { config, setConfig } = useStore.getState();
                setConfig({ roots: (config?.roots ?? []).filter((r) => r !== node.path) }).then(() =>
                  useStore.getState().refreshCrates(),
                );
              }}
            >
              Remove folder
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        row
      )}
      {open && node.children.map((c) => <Row key={c.path} node={c} depth={depth + 1} isRoot={false} />)}
    </>
  );
}

const HISTORY: View[] = [
  { kind: "history", days: 7, name: "Last 7 days" },
  { kind: "history", days: 30, name: "Last 30 days" },
];

function SmartCrates() {
  const smart = useStore((s) => s.config?.smartCrates ?? EMPTY);
  const current = useStore((s) => viewKey(s.view));
  const s = useStore.getState;
  return (
    <>
      <div className="mt-3 flex h-7 items-center justify-between px-1.5 text-[11px] text-muted-foreground/70">
        <span>Smart crates</span>
        <button
          aria-label="New smart crate"
          onClick={() => s().setSmartEdit(newSmartCrate())}
          className="rounded p-1 hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {smart.map((c) => {
        const v = { kind: "smart" as const, id: c.id, name: c.name };
        return (
          <ContextMenu key={c.id}>
            <ContextMenuTrigger asChild>
              <button
                onClick={() => s().openView(v)}
                onDoubleClick={() => s().setSmartEdit(c)}
                className={cn(
                  "flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
                  current === viewKey(v) && "bg-accent text-foreground",
                )}
              >
                <ListFilter className="size-4 shrink-0" />
                <span className="truncate">{c.name}</span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => s().setSmartEdit(c)}>Edit rules</ContextMenuItem>
              <ContextMenuItem
                onSelect={() => s().setConfig({ smartCrates: smart.filter((x) => x.id !== c.id) })}
              >
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </>
  );
}

export function Sidebar() {
  const [sizes, setSize] = useSizes("mono.layout.sidebar", { sidebar: 224 });
  const compact = useCompact();
  const navOpen = useStore((s) => s.navOpen);
  const view = useStore((s) => viewKey(s.view));

  // Phones: the crates live in a drawer, which closes once a view is picked.
  useEffect(() => {
    useStore.getState().setNavOpen(false);
  }, [view]);

  if (compact) {
    return (
      <Sheet open={navOpen} onOpenChange={(v) => useStore.getState().setNavOpen(v)}>
        <SheetContent side="left" className="w-72 gap-0 p-0 pt-10">
          <SheetTitle className="sr-only">Crates</SheetTitle>
          <SheetDescription className="sr-only">Crates, smart crates and history</SheetDescription>
          <SidebarContent />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside className="relative flex shrink-0 flex-col border-r" style={{ width: sizes.sidebar }}>
      <ResizeHandle
        onPointerDown={(e) =>
          startDrag(e, sizes.sidebar, (v) => setSize("sidebar", v), { min: 160, max: 480 })
        }
        onDoubleClick={() => setSize("sidebar", 224)}
      />
      <SidebarContent />
    </aside>
  );
}

function SidebarContent() {
  const crates = useStore((s) => s.crates);
  const current = useStore((s) => viewKey(s.view));
  const historyOn = useStore((s) => s.config?.history ?? true);

  return (
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          <div className="flex h-7 items-center justify-between px-1.5 text-[11px] text-muted-foreground/70">
            <span>Crates</span>
            <button
              aria-label="Add folder"
              onClick={addFolder}
              className="rounded p-1 hover:bg-accent hover:text-foreground"
            >
              <FolderPlus className="size-3.5" />
            </button>
          </div>
          {crates.map((c) => (
            <Row key={c.path} node={c} depth={0} isRoot />
          ))}

          <SmartCrates />

          {historyOn && (
            <>
              <div className="mt-3 flex h-7 items-center px-1.5 text-[11px] text-muted-foreground/70">History</div>
              {HISTORY.map((v) => (
                <button
                  key={viewKey(v)}
                  onClick={() => useStore.getState().openView(v)}
                  className={cn(
                    "flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
                    current === viewKey(v) && "bg-accent text-foreground",
                  )}
                >
                  <History className="size-4" />
                  {v.name}
                </button>
              ))}
            </>
          )}
        </div>
      </ScrollArea>
  );
}
