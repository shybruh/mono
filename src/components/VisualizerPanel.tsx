import { useStore } from "@/lib/store";
import { PeakMeter, Scope, Spectrum, fmtDb, useReadout } from "./meters/Meters";

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

export function VisualizerPanel() {
  const open = useStore((s) => s.config?.vizOpen ?? false);
  if (!open) return null;
  return (
    <div className="flex h-40 shrink-0 gap-4 border-t px-4 py-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="relative min-w-0 flex-[3]">
        <Spectrum grid className="h-full w-full" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-between font-mono text-[10px] text-muted-foreground/50">
          <span>20</span>
          <span>100</span>
          <span>1k</span>
          <span>10k</span>
          <span>20k</span>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <Scope className="h-full w-full" />
      </div>
      <PeakMeter vertical className="h-full w-5" />
      <Readouts />
    </div>
  );
}
