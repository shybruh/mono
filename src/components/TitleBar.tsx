import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowDownToLine,
  AudioWaveform,
  Loader2,
  Minus,
  PictureInPicture2,
  Settings2,
  Square,
  Tags,
  X,
} from "lucide-react";
import { installUpdate, useUpdater } from "@/lib/updater";
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

/** Appears only when a signed update is waiting; click to install and restart. */
function UpdateButton() {
  const { status, update, progress } = useUpdater();
  if (!update || (status !== "available" && status !== "downloading" && status !== "installing")) return null;
  const busy = status !== "available";
  return (
    <button
      disabled={busy}
      onClick={installUpdate}
      title={`Update to ${update.version}`}
      className="mr-1 flex h-6 items-center gap-1.5 rounded-md bg-brand-muted px-2 font-mono text-[11px] text-brand-muted-foreground hover:bg-brand hover:text-brand-foreground disabled:opacity-80 [&_svg]:size-3.5"
    >
      {busy ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />}
      {status === "downloading"
        ? `${Math.round(progress * 100)}%`
        : status === "installing"
          ? "Installing"
          : update.version}
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
        <UpdateButton />
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
