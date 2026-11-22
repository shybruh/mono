import { EMPTY, useStore } from "@/lib/store";
import { ResizeHandle, startDrag, useSizes } from "@/hooks/useDragSize";
import { PeakMeter, Scope, Spectrogram, Spectrum, Vectorscope, fmtDb, useReadout } from "./meters/Meters";
import { cn } from "@/lib/utils";

function Readout({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  return (
    <div className="flex flex-col items-end">
      <span className="font-mono text-xl leading-none text-brand tabular-nums">{fmtDb(value)}</span>
      <span className="mt-1 font-mono text-[10px] text-muted-foreground">
        {label} {unit}
      </span>
    </div>
  );
}

function Readouts() {
  const m = useReadout((x) => x.lufsM);
  const s = useReadout((x) => x.lufsS);
  const pk = useReadout((x) => Math.max(x.peakL, x.peakR));
  return (
    <div className="flex w-20 flex-col justify-between py-1">
      <Readout label="M" value={m} unit="LUFS" />
      <Readout label="S" value={s} unit="LUFS" />
      <Readout label="PK" value={pk} unit="dBFS" />
    </div>
  );
}

/** Small tab pair in a pane's corner; the choice is saved in vizMeters. */
function ModeTabs({ a, b, labels }: { a: string; b: string; labels: [string, string] }) {
  const meters = useStore((s) => s.config?.vizMeters ?? EMPTY);
  const showB = meters.includes(b);
  const pick = (useB: boolean) => {
    const rest = meters.filter((m) => m !== a && m !== b);
    useStore.getState().setConfig({ vizMeters: [...rest, useB ? b : a] });
  };
  return (
    <div className="absolute top-0 left-0 z-10 flex gap-0.5 rounded-md bg-background/70 p-0.5 font-mono text-[10px] backdrop-blur">
      {[false, true].map((useB, i) => (
        <button
          key={i}
          onClick={() => pick(useB)}
          className={cn(
            "rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground",
            showB === useB && "bg-accent text-foreground",
          )}
        >
          {labels[i]}
        </button>
      ))}
    </div>
  );
}

export function VisualizerPanel() {
  const open = useStore((s) => s.config?.vizOpen ?? false);
  const meters = useStore((s) => s.config?.vizMeters ?? EMPTY);
  const [size, setSize] = useSizes("mono.layout.viz", { height: 160 });
  if (!open) return null;
  const spectrogram = meters.includes("spectrogram");
  const vectorscope = meters.includes("vectorscope");
  return (
    <div
      className="relative flex shrink-0 gap-4 border-t px-4 py-3 animate-in fade-in slide-in-from-bottom-2 duration-200"
      style={{ height: size.height }}
    >
      <ResizeHandle
        side="top"
        onPointerDown={(e) =>
          startDrag(e, size.height, (v) => setSize("height", v), {
            min: 90,
            max: Math.max(160, Math.round(window.innerHeight * 0.65)),
            invert: true,
            axis: "y",
          })
        }
        onDoubleClick={() => setSize("height", 160)}
      />
      <div className="relative min-w-0 flex-[3]">
        <ModeTabs a="spectrum" b="spectrogram" labels={["Spectrum", "Spectrogram"]} />
        {spectrogram ? <Spectrogram className="h-full w-full" /> : <Spectrum grid className="h-full w-full" />}
        {!spectrogram && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-between font-mono text-[10px] text-muted-foreground/50">
            <span>20</span>
            <span>100</span>
            <span>1k</span>
            <span>10k</span>
            <span>20k</span>
          </div>
        )}
      </div>
      <div className={cn("relative min-w-0", vectorscope ? "aspect-square h-full flex-none" : "flex-1")}>
        <ModeTabs a="scope" b="vectorscope" labels={["Scope", "Vector"]} />
        {vectorscope ? <Vectorscope className="h-full w-full" /> : <Scope className="h-full w-full" />}
      </div>
      <PeakMeter vertical className="h-full w-5" />
      <Readouts />
    </div>
  );
}
