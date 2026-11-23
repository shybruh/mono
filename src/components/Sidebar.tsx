import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronRight, Folder, FolderOpen, FolderPlus, History, ListFilter, ListMusic, Plus } from "lucide-react";
import { newSmartCrate } from "@/lib/smartCrate";
import type { CrateNode } from "@/lib/api";
import { EMPTY, useStore, viewKey, type View } from "@/lib/store";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { ResizeHandle, startDrag, useSizes } from "@/hooks/useDragSize";
import { useCompact } from "@/hooks/useCompact";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { DropZone } from "@/components/DropZone";

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

/** Parent key for the top level, whose order is the watched-folders list itself. */
const ROOTS = "";

/** Applies the saved order for one level; anything new keeps its natural place at the end. */
function ordered(parent: string, nodes: CrateNode[], order: Record<string, string[]> | undefined): CrateNode[] {
  const saved = parent === ROOTS ? null : order?.[parent];
  if (!saved?.length) return nodes;
  const rank = new Map(saved.map((p, i) => [p, i]));
  return nodes
    .map((n, i) => ({ n, r: rank.get(n.path) ?? saved.length + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.n);
}

/** Saves a new order for one level of the crate tree. */
async function saveOrder(parent: string, paths: string[]) {
  const { config, setConfig } = useStore.getState();
  if (!config) return;
  if (parent === ROOTS) {
    // Keep any watched folder that isn't on screen (e.g. a drive that's missing).
    const rest = config.roots.filter((r) => !paths.includes(r));
    await setConfig({ roots: [...paths, ...rest] });
    await useStore.getState().refreshCrates();
  } else {
    await setConfig({ crateOrder: { ...(config.crateOrder ?? {}), [parent]: paths } });
  }
}

// A drag that just ended shouldn't also open the folder it was released on.
let swallowClick = false;

/** One level of the tree: its folders, in the saved order, reorderable by dragging. */
function CrateList({ parent, nodes, depth }: { parent: string; nodes: CrateNode[]; depth: number }) {
  const order = useStore((s) => s.config?.crateOrder);
  const list = ordered(parent, nodes, order);
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [slot, setSlot] = useState<number | null>(null);

  const move = (from: number, to: number) => {
    if (to === from || to < 0 || to >= list.length) return;
    const paths = list.map((n) => n.path);
    const [p] = paths.splice(from, 1);
    paths.splice(to, 0, p);
    saveOrder(parent, paths);
  };

  const pick = (k: number) => (e: React.PointerEvent) => {
    if (e.button !== 0 || list.length < 2 || (e.target as Element).closest("[data-chevron]")) return;
    const y0 = e.clientY;
    let active = false;
    let at: number | null = null;
    const slotAt = (y: number) => {
      const rows = box.current?.querySelectorAll<HTMLElement>(":scope > [data-ci] > [data-crate-row]");
      if (!rows?.length) return null;
      for (const [i, el] of [...rows].entries()) {
        const r = el.getBoundingClientRect();
        if (y < r.top + r.height / 2) return i;
      }
      return rows.length;
    };
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientY - y0) < 4) return;
        active = true;
        setDrag(k);
        document.body.style.cursor = "grabbing";
      }
      at = slotAt(ev.clientY);
      setSlot(at);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      if (active) {
        swallowClick = true;
        window.setTimeout(() => (swallowClick = false), 0);
        if (at != null) move(k, at > k ? at - 1 : at);
      }
      setDrag(null);
      setSlot(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div ref={box}>
      {list.map((n, i) => {
        const above = drag != null && slot === i && i !== drag && i !== drag + 1;
        const below = drag != null && i === list.length - 1 && slot === list.length && drag !== list.length - 1;
        return (
          <div
            key={n.path}
            data-ci={i}
            className={cn(
              "relative",
              (above || below) &&
                "after:absolute after:right-1 after:left-[var(--indent)] after:h-0.5 after:rounded-full after:bg-brand",
              above && "after:-top-px",
              below && "after:-bottom-px",
            )}
            style={above || below ? ({ "--indent": `${8 + depth * 12}px` } as React.CSSProperties) : undefined}
          >
            <Row
              node={n}
              depth={depth}
              isRoot={parent === ROOTS}
              dragging={drag === i}
              onPointerDown={pick(i)}
              onMove={(d) => move(i, i + d)}
              canUp={i > 0}
              canDown={i < list.length - 1}
            />
          </div>
        );
      })}
    </div>
  );
}

function Row({
  node,
  depth,
  isRoot,
  dragging,
  onPointerDown,
  onMove,
  canUp,
  canDown,
}: {
  node: CrateNode;
  depth: number;
  isRoot: boolean;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onMove: (delta: -1 | 1) => void;
  canUp: boolean;
  canDown: boolean;
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
      data-crate-row
      onPointerDown={onPointerDown}
      onClick={() => {
        if (swallowClick) return;
        useStore.getState().openView({ kind: "crate", path: node.path, name: node.name });
      }}
      onDoubleClick={() => hasKids && setOpen(!open)}
      className={cn(
        "group flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
        active && "bg-accent text-foreground",
        dragging && "bg-accent/60 opacity-50",
      )}
      style={{ paddingLeft: 4 + depth * 12 }}
    >
      <span
        role="button"
        data-chevron
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
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={!canUp} onSelect={() => onMove(-1)}>
            Move up
          </ContextMenuItem>
          <ContextMenuItem disabled={!canDown} onSelect={() => onMove(1)}>
            Move down
          </ContextMenuItem>
          {isRoot && (
            <>
              <ContextMenuSeparator />
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
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {open && hasKids && <CrateList parent={node.path} nodes={node.children} depth={depth + 1} />}
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
  const dropping = useStore((s) => s.dropping);
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
      <DropZone on={dropping === "folder"} icon={FolderPlus} />
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
          <CrateList parent={ROOTS} nodes={crates} depth={0} />

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
