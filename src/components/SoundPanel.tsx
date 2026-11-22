import { SlidersVertical } from "lucide-react";
import { api, type Config } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const BANDS = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];

const PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "Bass boost": [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  "Treble boost": [0, 0, 0, 0, 0, 0, 2, 4, 5, 6],
  Vocal: [-2, -2, -1, 1, 3, 3, 2, 1, 0, -1],
  Loudness: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5],
  Electronic: [5, 4, 1, 0, -2, 0, 1, 2, 4, 5],
  Acoustic: [3, 3, 2, 1, 1, 1, 2, 2, 2, 1],
};

const CROSSFEED: [string, number][] = [
  ["Off", 0],
  ["Low", 0.3],
  ["Medium", 0.5],
  ["High", 0.7],
];

let persistTimer: number | undefined;

/** Applies immediately (engine + UI) and saves shortly after the last change. */
function update(patch: Partial<Config>) {
  const c = useStore.getState().config;
  if (!c) return;
  useStore.setState({ config: { ...c, ...patch } });
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    const cur = useStore.getState().config;
    if (cur) api.updateConfig({ eq: cur.eq, crossfeed: cur.crossfeed, crossfade: cur.crossfade });
  }, 120);
}

const sign = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : "0");

export function SoundPanel() {
  const config = useStore((s) => s.config);
  if (!config) return null;
  const { eq, crossfeed, crossfade } = config;
  const preset = Object.entries(PRESETS).find(([, g]) => g.every((v, i) => v === eq.gains[i]))?.[0];
  const changed = (eq.enabled && eq.gains.some((g) => g !== 0)) || crossfeed > 0 || crossfade > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label="Sound"
          title="Equaliser and sound"
          className={cn(
            "rounded p-1 text-muted-foreground hover:text-foreground [&_svg]:size-4",
            changed && "text-brand hover:text-brand",
          )}
        >
          <SlidersVertical />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[440px] space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium">Equaliser</span>
          <Switch checked={eq.enabled} onCheckedChange={(v) => update({ eq: { ...eq, enabled: v } })} />
        </div>

        <div className={cn("space-y-3", !eq.enabled && "pointer-events-none opacity-40")}>
          <div className="flex flex-wrap gap-1">
            {Object.keys(PRESETS).map((name) => (
              <button
                key={name}
                onClick={() => update({ eq: { ...eq, gains: PRESETS[name] as typeof eq.gains } })}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground",
                  preset === name && "border-brand text-brand",
                )}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="flex items-end justify-between gap-1">
            {BANDS.map((label, i) => (
              <div key={label} className="flex w-8 flex-col items-center gap-1.5">
                <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{sign(eq.gains[i])}</span>
                <Slider
                  orientation="vertical"
                  className="h-28"
                  min={-12}
                  max={12}
                  step={1}
                  value={[eq.gains[i]]}
                  onValueChange={([v]) => {
                    const gains = [...eq.gains] as typeof eq.gains;
                    gains[i] = v;
                    update({ eq: { ...eq, gains } });
                  }}
                  onDoubleClick={() => {
                    const gains = [...eq.gains] as typeof eq.gains;
                    gains[i] = 0;
                    update({ eq: { ...eq, gains } });
                  }}
                />
                <span className="font-mono text-[10px] text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <span className="w-16 text-[12px] text-muted-foreground">Pre-amp</span>
            <Slider
              className="flex-1"
              min={-12}
              max={12}
              step={0.5}
              value={[eq.preamp]}
              onValueChange={([v]) => update({ eq: { ...eq, preamp: v } })}
              onDoubleClick={() => update({ eq: { ...eq, preamp: 0 } })}
            />
            <span className="w-14 text-right font-mono text-[11px] tabular-nums">{sign(eq.preamp)} dB</span>
          </div>
        </div>

        <div className="space-y-3 border-t pt-3">
          <div className="flex items-center gap-3">
            <span className="w-16 text-[12px] text-muted-foreground">Crossfeed</span>
            <div className="flex flex-1 gap-1">
              {CROSSFEED.map(([name, v]) => (
                <button
                  key={name}
                  onClick={() => update({ crossfeed: v })}
                  className={cn(
                    "flex-1 rounded-md border py-1 text-[11px] text-muted-foreground hover:text-foreground",
                    Math.abs(crossfeed - v) < 0.01 && "border-brand text-brand",
                  )}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-16 text-[12px] text-muted-foreground">Crossfade</span>
            <Slider
              className="flex-1"
              min={0}
              max={12}
              step={0.5}
              value={[crossfade]}
              onValueChange={([v]) => update({ crossfade: v })}
            />
            <span className="w-14 text-right font-mono text-[11px] tabular-nums">
              {crossfade > 0 ? `${crossfade.toFixed(1)} s` : "Gapless"}
            </span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
