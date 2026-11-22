import { useRef, useState } from "react";
import { Pause, Play, Repeat, Repeat1, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { cn, fmtTime } from "@/lib/utils";
import { SeekBar } from "./SeekBar";

const btn =
  "flex h-[34px] min-w-[34px] items-center justify-center rounded-lg border border-input/80 text-foreground/85 transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-[17px]";

export function TransportButtons({ compact = false }: { compact?: boolean }) {
  const playing = useStore((s) => s.player.playing);
  return (
    <div className={cn("flex items-center", compact ? "gap-1" : "gap-2.5")}>
      <button aria-label="Previous" className={btn} onClick={() => api.prev()}>
        <SkipBack />
      </button>
      <button
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => api.toggle()}
        className="flex size-[42px] items-center justify-center rounded-full bg-brand text-brand-foreground transition-colors hover:bg-brand-strong [&_svg]:size-[19px] [&_svg]:fill-current"
      >
        {playing ? <Pause /> : <Play className="translate-x-px" />}
      </button>
      <button aria-label="Next" className={btn} onClick={() => api.next()}>
        <SkipForward />
      </button>
    </div>
  );
}

function SpeedPitch() {
  const speed = useStore((s) => s.player.speed);
  const semis = useStore((s) => s.player.semitones);
  const changed = Math.abs(speed - 1) > 0.001 || Math.abs(semis) > 0.001;
  const label = `${speed.toFixed(2)}×${Math.abs(semis) > 0.001 ? ` ${semis > 0 ? "+" : "−"}${Math.abs(semis).toFixed(1)}` : ""}`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={cn(btn, "px-2.5 font-mono text-xs text-muted-foreground", changed && "border-brand text-brand")}>
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 space-y-4">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">Tempo</span>
            <span className="font-mono tabular-nums">{speed.toFixed(2)}×</span>
          </div>
          <Slider
            min={0.5}
            max={2}
            step={0.01}
            value={[speed]}
            onValueChange={([v]) => {
              useStore.setState((s) => ({ player: { ...s.player, speed: v } }));
              api.setSpeed(v);
            }}
            onDoubleClick={() => api.setSpeed(1)}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">Pitch</span>
            <span className="font-mono tabular-nums">
              {semis > 0 ? "+" : semis < 0 ? "−" : ""}
              {Math.abs(semis).toFixed(1)} st
            </span>
          </div>
          <Slider
            min={-12}
            max={12}
            step={0.1}
            value={[semis]}
            onValueChange={([v]) => {
              useStore.setState((s) => ({ player: { ...s.player, semitones: v } }));
              api.setPitch(v);
            }}
            onDoubleClick={() => api.setPitch(0)}
          />
        </div>
        <button
          onClick={() => {
            api.setSpeed(1);
            api.setPitch(0);
          }}
          className="w-full rounded-md border py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Reset
        </button>
      </PopoverContent>
    </Popover>
  );
}

function LoopButtons() {
  const a = useStore((s) => s.player.loopA);
  const b = useStore((s) => s.player.loopB);
  const { setA, setB } = useStore.getState();
  return (
    <>
      <button
        title={a != null ? `A ${fmtTime(a)}` : "Set A"}
        onClick={setA}
        className={cn(btn, "px-2.5 font-mono text-xs text-muted-foreground", a != null && "border-brand text-brand")}
      >
        A
      </button>
      <button
        title={b != null ? `B ${fmtTime(b)}` : "Set B"}
        onClick={setB}
        className={cn(btn, "px-2.5 font-mono text-xs text-muted-foreground", b != null && "border-brand text-brand")}
      >
        B
      </button>
    </>
  );
}

function Volume() {
  const volume = useStore((s) => s.player.volume);
  const last = useRef(0.8);
  const [, force] = useState(0);
  const Icon = volume <= 0.001 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const set = (v: number, commit: boolean) => {
    useStore.setState((s) => ({ player: { ...s.player, volume: v } }));
    api.setVolume(v);
    if (commit) useStore.getState().setConfig({ volume: v });
    force((n) => n + 1);
  };
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <button
        aria-label="Mute"
        className="rounded p-1 hover:text-foreground [&_svg]:size-4"
        onClick={() => {
          if (volume > 0.001) {
            last.current = volume;
            set(0, true);
          } else set(last.current || 0.8, true);
        }}
      >
        <Icon />
      </button>
      <Slider
        className="w-24"
        min={0}
        max={1}
        step={0.01}
        value={[Math.min(1, volume)]}
        onValueChange={([v]) => set(v, false)}
        onValueCommit={([v]) => set(v, true)}
      />
    </div>
  );
}

export function Transport() {
  const repeat = useStore((s) => s.player.repeat);
  return (
    <div className="relative z-10 shrink-0 border-t bg-background px-4 pb-3.5 pt-5">
      <SeekBar />
      <div className="mt-3.5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <TransportButtons />
          <span className="mx-1 h-6 w-px bg-border" />
          <LoopButtons />
          <SpeedPitch />
          <button
            aria-label={`Repeat ${repeat}`}
            title={`Repeat ${repeat}`}
            onClick={() => useStore.getState().cycleRepeat()}
            className={cn(btn, "text-muted-foreground", repeat !== "off" && "border-brand text-brand")}
          >
            {repeat === "one" ? <Repeat1 /> : <Repeat />}
          </button>
        </div>
        <Volume />
      </div>
    </div>
  );
}
