import { useStore } from "@/lib/store";
import { basename, cn } from "@/lib/utils";
import { centreOf } from "@/lib/motion";
import { LayoutGrid, Rows3 } from "lucide-react";

function Chip({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      className={
        muted
          ? "rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          : "rounded bg-brand-muted px-1.5 py-0.5 font-mono text-[11px] text-brand-muted-foreground"
      }
    >
      {children}
    </span>
  );
}

export function NowPlaying() {
  const track = useStore((s) => s.track);
  const cover = useStore((s) => s.cover);
  const view = useStore((s) => s.view);
  const queueKey = useStore((s) => s.queueKey);
  const layout = useStore((s) => s.layout);

  const m = track?.meta;
  const source = (() => {
    if (!m) return view?.name ?? "";
    if (queueKey?.startsWith("history:")) return queueKey === "history:7" ? "Last 7 days" : "Last 30 days";
    const dir = m.path.split(/[\\/]/).slice(-2, -1)[0];
    return dir ?? "";
  })();

  const khz = m?.sampleRate ? `${(m.sampleRate / 1000).toFixed(m.sampleRate % 1000 ? 1 : 0)} kHz` : null;
  const ch = m?.channels === 1 ? "Mono" : m?.channels === 2 ? "Stereo" : m?.channels ? `${m.channels} ch` : null;

  return (
    <div className="relative flex items-end gap-4 border-b p-4 max-sm:items-center max-sm:gap-3 max-sm:p-3">
      <div className="absolute top-3 right-3 flex gap-0.5 rounded-md border p-0.5">
        {(["list", "albums"] as const).map((l) => (
          <button
            key={l}
            aria-label={l === "list" ? "Track list" : "Album grid"}
            title={l === "list" ? "Track list" : "Album grid"}
            onClick={() => useStore.getState().setLayout(l)}
            className={cn(
              "rounded p-1 text-muted-foreground hover:text-foreground [&_svg]:size-3.5",
              layout === l && "bg-accent text-foreground",
            )}
          >
            {l === "list" ? <Rows3 /> : <LayoutGrid />}
          </button>
        ))}
      </div>
      <button
        aria-label="Theater"
        onClick={(e) => useStore.getState().toggleTheater(true, centreOf(e.currentTarget))}
        className="size-24 shrink-0 overflow-hidden rounded-lg bg-brand-wash transition-transform hover:scale-[1.03] max-sm:size-16"
      >
        {cover && <img key={cover} src={cover} alt="" className="size-full animate-fade object-cover" draggable={false} />}
      </button>
      <div key={m?.path ?? ""} className="min-w-0 flex-1 animate-rise max-sm:pr-14">
        <div className="truncate text-[11px] text-brand">{source}</div>
        <div className="mt-0.5 truncate text-lg font-medium leading-tight max-sm:text-base">
          {m ? m.title : <span className="text-muted-foreground">—</span>}
        </div>
        <div className="truncate text-muted-foreground">
          {m ? [m.artist, m.album].filter(Boolean).join(" — ") || basename(m.path) : " "}
        </div>
        {m && (
          <div className="mt-2 flex flex-wrap gap-1.5 max-sm:hidden">
            {m.bitrate ? <Chip>{m.bitrate} kbps</Chip> : null}
            {khz && <Chip>{khz}</Chip>}
            {m.bitDepth ? <Chip>{m.bitDepth}-bit</Chip> : null}
            {ch && <Chip>{ch}</Chip>}
            <Chip muted>{m.format}</Chip>
            {track && Math.abs(track.gainDb) > 0.05 && (
              <Chip muted>
                RG {track.gainDb > 0 ? "+" : "−"}
                {Math.abs(track.gainDb).toFixed(1)} dB
              </Chip>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
