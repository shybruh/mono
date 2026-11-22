import { getCurrentWindow } from "@tauri-apps/api/window";
import { AudioWaveform, Minus, PictureInPicture2, Settings2, Square, Tags, X } from "lucide-react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const win = getCurrentWindow();

function IconBtn({
  label,
  active,
  onClick,
  children,
  className,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4",
        active && "text-brand hover:text-brand",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TitleBar() {
  const vizOpen = useStore((s) => s.config?.vizOpen ?? false);
  const track = useStore((s) => s.track);
  const list = useStore((s) => s.list);
  const selected = useStore((s) => s.selected);

  const tagPath = (selected != null && list[selected]?.path) || track?.meta.path || null;

  return (
    <div
      className="flex h-10 shrink-0 items-center justify-between border-b pl-3"
      onMouseDown={(e) => {
        if (e.button === 0 && (e.target as HTMLElement).closest("button") == null) {
          if (e.detail === 2) win.toggleMaximize();
          else win.startDragging();
        }
      }}
    >
      <span className="text-[13px] font-medium tracking-tight">mono</span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => useStore.getState().setPalette(true)}
          className="mr-1 rounded border bg-secondary/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
        >
          Ctrl K
        </button>
        <IconBtn label="Visualiser" active={vizOpen} onClick={() => useStore.getState().toggleViz()}>
          <AudioWaveform />
        </IconBtn>
        <IconBtn label="Micro-deck" onClick={() => api.openDeck()}>
          <PictureInPicture2 />
        </IconBtn>
        <IconBtn label="Tags" onClick={() => tagPath && useStore.getState().openTags(tagPath)}>
          <Tags />
        </IconBtn>
        <IconBtn label="Settings" onClick={() => useStore.getState().setSettings(true)}>
          <Settings2 />
        </IconBtn>
        <div className="ml-2 flex h-10 items-stretch">
          <button
            aria-label="Minimise"
            onClick={() => win.minimize()}
            className="flex w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4"
          >
            <Minus />
          </button>
          <button
            aria-label="Maximise"
            onClick={() => win.toggleMaximize()}
            className="flex w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
          >
            <Square />
          </button>
          <button
            aria-label="Close"
            onClick={() => win.close()}
            className="flex w-11 items-center justify-center text-muted-foreground hover:bg-red-600 hover:text-white [&_svg]:size-4"
          >
            <X />
          </button>
        </div>
      </div>
    </div>
  );
}
