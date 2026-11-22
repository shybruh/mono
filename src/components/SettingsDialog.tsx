import { useEffect, useState } from "react";
import { AudioLines, FolderPlus, Info, Library, Moon, Palette, Play, Plug, SlidersVertical, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { checkForUpdate, installUpdate, useUpdater } from "@/lib/updater";
import { cancelSleep, fmtRemaining, startSleep, useSleep } from "@/lib/sleep";
import { fmtFreq, KIND_LABEL } from "@/lib/eq";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { addFolder } from "./Sidebar";
import { ThemePicker } from "./ThemePicker";
import { themeById } from "@/lib/theme";

const PAGES = [
  { id: "library", label: "Library", icon: Library },
  { id: "playback", label: "Playback", icon: Play },
  { id: "sound", label: "Sound", icon: AudioLines },
  { id: "sleep", label: "Sleep timer", icon: Moon },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "services", label: "Services", icon: Plug },
  { id: "about", label: "About", icon: Info },
] as const;
type Page = (typeof PAGES)[number]["id"];

function Row({ label, detail, children }: { label: string; detail?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-6 px-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px]">{label}</div>
        {detail && <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{detail}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}

function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      {title && <h3 className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>}
      <div className="divide-y rounded-lg border bg-card/40">{children}</div>
    </section>
  );
}

const db = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} dB`;

function LibraryPage() {
  const config = useStore((s) => s.config)!;
  const setConfig = useStore((s) => s.setConfig);
  return (
    <Group title="Watched folders">
      {config.roots.map((r) => (
        <div key={r} className="flex h-11 items-center justify-between gap-4 px-4">
          <span className="truncate font-mono text-[12px]">{r}</span>
          <button
            aria-label="Remove"
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            onClick={() =>
              setConfig({ roots: config.roots.filter((x) => x !== r) }).then(() => useStore.getState().refreshCrates())
            }
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        onClick={addFolder}
        className="flex h-11 w-full items-center gap-2 px-4 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <FolderPlus className="size-4" /> Add folder
      </button>
    </Group>
  );
}

function PlaybackPage() {
  const config = useStore((s) => s.config)!;
  const setConfig = useStore((s) => s.setConfig);
  const [preamp, setPreamp] = useState(config.rgPreamp);
  useEffect(() => setPreamp(config.rgPreamp), [config.rgPreamp]);
  return (
    <>
      <Group title="Loudness">
        <Row label="ReplayGain">
          <Select value={config.rgMode} onValueChange={(v) => setConfig({ rgMode: v as typeof config.rgMode })}>
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="track">Track</SelectItem>
              <SelectItem value="album">Album</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label="ReplayGain pre-amp">
          <Slider
            className="w-44"
            min={-12}
            max={12}
            step={0.5}
            value={[preamp]}
            disabled={config.rgMode === "off"}
            onValueChange={([v]) => setPreamp(v)}
            onValueCommit={([v]) => setConfig({ rgPreamp: v })}
          />
          <span className="w-16 text-right font-mono text-[12px] tabular-nums">{db(preamp)}</span>
        </Row>
      </Group>
      <Group title="Behaviour">
        <Row label="Resume where you left off">
          <Switch checked={config.resume} onCheckedChange={(v) => setConfig({ resume: v })} />
        </Row>
        <Row label="Seek control">
          <Select value={config.seekStyle} onValueChange={(v) => setConfig({ seekStyle: v as typeof config.seekStyle })}>
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="waveform">Waveform</SelectItem>
              <SelectItem value="bar">Bar</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      </Group>
    </>
  );
}

const CROSSFEED: [string, number][] = [
  ["Off", 0],
  ["Low", 0.3],
  ["Medium", 0.5],
  ["High", 0.7],
];

function SoundPage() {
  const config = useStore((s) => s.config)!;
  const eq = config.eq;
  const [xf, setXf] = useState(config.crossfade);
  useEffect(() => setXf(config.crossfade), [config.crossfade]);
  const bands = eq.bands.filter((b) => b.enabled);
  const summary = bands.length
    ? bands.map((b) => `${KIND_LABEL[b.kind]} ${fmtFreq(b.freq)}`).join(" · ")
    : "No bands";
  const open = () => {
    const s = useStore.getState();
    s.setSettings(false);
    s.setEqOpen(true);
  };
  return (
    <Group title="Equaliser">
      <Row label="Parametric equaliser" detail={summary}>
        <Switch
          checked={eq.enabled}
          onCheckedChange={(v) => useStore.getState().setConfig({ eq: { ...eq, enabled: v } })}
        />
        <Button size="sm" variant="outline" onClick={open}>
          <SlidersVertical /> Open
        </Button>
      </Row>
      <Row label="Crossfeed">
        <Select
          value={String(config.crossfeed)}
          onValueChange={(v) => useStore.getState().setConfig({ crossfeed: Number(v) })}
        >
          <SelectTrigger size="sm" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CROSSFEED.map(([name, v]) => (
              <SelectItem key={name} value={String(v)}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label="Crossfade">
        <Slider
          className="w-44"
          min={0}
          max={12}
          step={0.5}
          value={[xf]}
          onValueChange={([v]) => setXf(v)}
          onValueCommit={([v]) => useStore.getState().setConfig({ crossfade: v })}
        />
        <span className="w-16 text-right font-mono text-[12px] tabular-nums">{xf > 0 ? `${xf.toFixed(1)} s` : "Gapless"}</span>
      </Row>
    </Group>
  );
}

const SLEEP_CHOICES = [15, 30, 45, 60, 90];

function SleepPage() {
  const { mode, remaining } = useSleep();
  return (
    <Group title="Pause after">
      <div className="flex flex-wrap gap-1.5 px-4 py-3">
        {SLEEP_CHOICES.map((m) => (
          <Button key={m} size="sm" variant="outline" onClick={() => startSleep(m)} className="min-w-16 font-mono">
            {m} min
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() => startSleep("track")}
          className={cn(mode?.kind === "track" && "border-brand text-brand")}
        >
          End of track
        </Button>
      </div>
      {mode && (
        <Row label={mode.kind === "track" ? "Pausing at the end of this track" : "Pausing in"}>
          <span className="font-mono text-[13px] text-brand tabular-nums">{fmtRemaining(remaining)}</span>
          <Button size="sm" variant="ghost" onClick={() => cancelSleep()}>
            Turn off
          </Button>
        </Row>
      )}
    </Group>
  );
}

function AppearancePage() {
  const config = useStore((s) => s.config)!;
  const setConfig = useStore((s) => s.setConfig);
  return (
    <>
      <section className="space-y-2">
        <h3 className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Theme</h3>
        <ThemePicker />
      </section>
      <Group>
        <Row label="Accent from cover art">
          <Switch
            checked={config.coverAccent}
            disabled={!themeById(config.theme).coverAccent}
            onCheckedChange={(v) => setConfig({ coverAccent: v })}
          />
        </Row>
      </Group>
    </>
  );
}

function ServicesPage({ builtin }: { builtin: boolean }) {
  const config = useStore((s) => s.config)!;
  const setConfig = useStore((s) => s.setConfig);
  const [appId, setAppId] = useState(config.discordAppId);
  useEffect(() => setAppId(config.discordAppId), [config.discordAppId]);
  return (
    <>
      <Group title="Library">
        <Row label="Listening history">
          <Switch checked={config.history} onCheckedChange={(v) => setConfig({ history: v })} />
        </Row>
        <Row label="Look up missing album info and cover art" detail="iTunes Search">
          <Switch checked={config.metaOnline} onCheckedChange={(v) => setConfig({ metaOnline: v })} />
        </Row>
        <Row label="Download lyrics" detail="LRCLIB">
          <Switch checked={config.lyricsOnline} onCheckedChange={(v) => setConfig({ lyricsOnline: v })} />
        </Row>
      </Group>
      <Group title="Discord">
        <Row label="Rich Presence">
          <Switch checked={config.discord} onCheckedChange={(v) => setConfig({ discord: v })} />
        </Row>
        {config.discord && (
          <Row label="Album art" detail="iTunes Search">
            <Switch checked={config.discordArt} onCheckedChange={(v) => setConfig({ discordArt: v })} />
          </Row>
        )}
        {config.discord && (
          <Row label={builtin ? "Application ID override" : "Application ID"}>
            <Input
              value={appId}
              placeholder={builtin ? "Built-in" : ""}
              onChange={(e) => setAppId(e.target.value.replace(/\D/g, ""))}
              onBlur={() => appId !== config.discordAppId && setConfig({ discordAppId: appId })}
              className="h-8 w-52 font-mono text-[12px]"
              inputMode="numeric"
            />
          </Row>
        )}
      </Group>
    </>
  );
}

function AboutPage({ version }: { version: string }) {
  const config = useStore((s) => s.config)!;
  const setConfig = useStore((s) => s.setConfig);
  const upd = useUpdater();
  const status =
    upd.status === "checking"
      ? "Checking"
      : upd.status === "current"
        ? "Up to date"
        : upd.status === "available" && upd.update
          ? `${upd.update.version} available`
          : upd.status === "downloading"
            ? `Downloading ${Math.round(upd.progress * 100)}%`
            : upd.status === "error"
              ? "Check failed"
              : undefined;
  return (
    <Group title="Updates">
      <Row label={version ? `Mono ${version}` : "Mono"} detail={status}>
        {upd.status === "available" ? (
          <Button size="sm" onClick={installUpdate} className="bg-brand text-brand-foreground hover:bg-brand-strong">
            Install and restart
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={upd.status === "checking" || upd.status === "downloading"}
            onClick={checkForUpdate}
          >
            Check now
          </Button>
        )}
      </Row>
      <Row label="Check for updates automatically">
        <Switch checked={config.autoUpdate} onCheckedChange={(v) => setConfig({ autoUpdate: v })} />
      </Row>
    </Group>
  );
}

export function SettingsDialog() {
  const open = useStore((s) => s.settings);
  const hasConfig = useStore((s) => !!s.config);
  const [page, setPage] = useState<Page>("library");
  const [builtin, setBuiltin] = useState(false);
  const [version, setVersion] = useState("");
  const sleeping = useSleep((s) => !!s.mode);

  useEffect(() => {
    api
      .appInfo()
      .then((i) => {
        setBuiltin(i.discordBuiltin);
        setVersion(i.version);
      })
      .catch(() => {});
  }, []);

  if (!hasConfig) return null;
  const current = PAGES.find((p) => p.id === page)!;

  return (
    <Dialog open={open} onOpenChange={(v) => useStore.getState().setSettings(v)}>
      <DialogContent className="flex h-[min(640px,85vh)] gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogDescription className="sr-only">Mono preferences</DialogDescription>
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r bg-muted/30 p-3">
          <DialogTitle className="px-2.5 pt-1 pb-3 text-sm font-medium">Settings</DialogTitle>
          <div className="relative flex flex-col gap-0.5">
            <span
              aria-hidden
              className="absolute inset-x-0 top-0 h-8 rounded-md bg-accent transition-transform duration-300 ease-[var(--ease-out-expo)]"
              style={{ transform: `translateY(${PAGES.findIndex((p) => p.id === page) * 34}px)` }}
            />
          {PAGES.map((p) => (
            <button
              key={p.id}
              onClick={() => setPage(p.id)}
              className={cn(
                "relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground hover:text-foreground active:scale-100 [&_svg]:size-4",
                page === p.id && "text-foreground",
              )}
            >
              <p.icon />
              {p.label}
              {p.id === "sleep" && sleeping && <span className="ml-auto size-1.5 rounded-full bg-brand" />}
            </button>
          ))}
          </div>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 shrink-0 items-center border-b px-6 pr-12">
            <h2 key={page} className="animate-fade text-[15px] font-medium">{current.label}</h2>
          </div>
          <div key={page} className="min-h-0 flex-1 animate-rise space-y-6 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable]">
            {page === "library" && <LibraryPage />}
            {page === "playback" && <PlaybackPage />}
            {page === "sound" && <SoundPage />}
            {page === "sleep" && <SleepPage />}
            {page === "appearance" && <AppearancePage />}
            {page === "services" && <ServicesPage builtin={builtin} />}
            {page === "about" && <AboutPage version={version} />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
