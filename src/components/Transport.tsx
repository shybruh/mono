import { useRef, useState } from "react";
import { useSleep, startSleep, cancelSleep, fmtRemaining } from "@/lib/sleep";
import { ListOrdered, Moon, MicVocal, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { cn, fmtTime } from "@/lib/utils";
import { SeekBar } from "./SeekBar";
import { SoundPanel } from "./SoundPanel";

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

const SLEEP_CHOICES = [15, 30, 45, 60, 90];

function SleepTimer() {
  const { mode, remaining } = useSleep();
  const [open, setOpen] = useState(false);
  const pick = (c: number | "track") => {
    startSleep(c);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label="Sleep timer"
          title="Sleep timer"
          className={cn(
            "flex items-center gap-1 rounded p-1 font-mono text-[11px] text-muted-foreground hover:text-foreground [&_svg]:size-4",
            mode && "text-brand hover:text-brand",
          )}
        >
          <Moon />
          {mode && <span className="tabular-nums">{fmtRemaining(remaining)}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-48 p-1">
        <div className="px-2 py-1.5 text-[11px] text-muted-foreground">Pause after</div>
        {SLEEP_CHOICES.map((m) => (
          <button
            key={m}
            onClick={() => pick(m)}
            className="flex w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
          >
            {m} minutes
          </button>
        ))}
        <button onClick={() => pick("track")} className="flex w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent">
          End of this track
        </button>
        {mode && (
          <button
            onClick={() => {
              cancelSleep();
              setOpen(false);
            }}
            className="mt-1 flex w-full rounded-md border-t px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Turn off
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function Transport() {
  const repeat = useStore((s) => s.player.repeat);
  const theater = useStore((s) => s.theater);
  const shuffle = useStore((s) => s.shuffle);
  return (
    <div className="relative z-10 shrink-0 border-t bg-background px-4 pb-3.5 pt-5">
      <SeekBar />
      {/* Symmetric cluster centred under the waveform; volume pinned right. */}
      <div className="mt-3.5 grid grid-cols-[1fr_auto_1fr] items-center">
        <div />
        <div className="flex items-center gap-2.5">
          <button
            aria-label="Shuffle"
            title="Shuffle (S)"
            onClick={() => useStore.getState().toggleShuffle()}
            className={cn(btn, "text-muted-foreground", shuffle && "border-brand text-brand")}
          >
            <Shuffle />
          </button>
          <LoopButtons />
          <span className="mx-1 h-6 w-px bg-border" />
          <TransportButtons />
          <span className="mx-1 h-6 w-px bg-border" />
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
        <div className="flex items-center justify-end gap-3">
          <SoundPanel />
          <SleepTimer />
          <button
            aria-label="Queue"
            title="Up next (Q)"
            onClick={() => useStore.getState().setQueueOpen(true)}
            className="rounded p-1 text-muted-foreground hover:text-foreground [&_svg]:size-4"
          >
            <ListOrdered />
          </button>
          <button
            aria-label="Theater"
            title="Theater (F)"
            onClick={() => useStore.getState().toggleTheater()}
            className={cn(
              "rounded p-1 text-muted-foreground hover:text-foreground [&_svg]:size-4",
              theater && "text-brand hover:text-brand",
            )}
          >
            <MicVocal />
          </button>
          <Volume />
        </div>
      </div>
    </div>
  );
}
