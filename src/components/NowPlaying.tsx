import { useStore } from "@/lib/store";
import { basename } from "@/lib/utils";

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
    <div className="flex items-end gap-4 border-b p-4">
      <div className="size-24 shrink-0 overflow-hidden rounded-lg bg-brand-wash">
        {cover && <img src={cover} alt="" className="size-full object-cover" draggable={false} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] text-brand">{source}</div>
        <div className="mt-0.5 truncate text-lg font-medium leading-tight">
          {m ? m.title : <span className="text-muted-foreground">—</span>}
        </div>
        <div className="truncate text-muted-foreground">
          {m ? [m.artist, m.album].filter(Boolean).join(" — ") || basename(m.path) : " "}
        </div>
        {m && (
          <div className="mt-2 flex flex-wrap gap-1.5">
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
