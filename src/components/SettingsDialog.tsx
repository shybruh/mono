import { useEffect, useState } from "react";
import { FolderPlus, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { addFolder } from "./Sidebar";
import { ThemePicker } from "./ThemePicker";
import { themeById } from "@/lib/theme";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-6">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[11px] text-muted-foreground/60">{title}</h3>
      {children}
    </section>
  );
}

export function SettingsDialog() {
  const open = useStore((s) => s.settings);
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);
  const [preamp, setPreamp] = useState(0);
  const [appId, setAppId] = useState("");
  const [builtin, setBuiltin] = useState(false);

  useEffect(() => {
    api.appInfo().then((i) => setBuiltin(i.discordBuiltin)).catch(() => {});
  }, []);

  useEffect(() => {
    if (config) {
      setPreamp(config.rgPreamp);
      setAppId(config.discordAppId);
    }
  }, [config, open]);

  if (!config) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => useStore.getState().setSettings(v)}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="text-sm font-medium">Settings</DialogTitle>
          <DialogDescription className="sr-only">Mono preferences</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6 [scrollbar-gutter:stable]">
          <Section title="Watched folders">
            <div className="space-y-1">
              {config.roots.map((r) => (
                <div key={r} className="flex h-8 items-center justify-between rounded-md border px-2.5">
                  <span className="truncate font-mono text-[12px]">{r}</span>
                  <button
                    aria-label="Remove"
                    className="rounded p-1 text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setConfig({ roots: config.roots.filter((x) => x !== r) }).then(() =>
                        useStore.getState().refreshCrates(),
                      )
                    }
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
              <button
                onClick={addFolder}
                className="flex h-8 w-full items-center gap-2 rounded-md border border-dashed px-2.5 text-[12px] text-muted-foreground hover:text-foreground"
              >
                <FolderPlus className="size-3.5" /> Add folder
              </button>
            </div>
          </Section>

          <Separator />

          <Section title="Playback">
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
            <Row label="Pre-amp">
              <Slider
                className="w-40"
                min={-12}
                max={12}
                step={0.5}
                value={[preamp]}
                disabled={config.rgMode === "off"}
                onValueChange={([v]) => setPreamp(v)}
                onValueCommit={([v]) => setConfig({ rgPreamp: v })}
              />
              <span className="w-14 text-right font-mono text-[12px] tabular-nums">
                {preamp > 0 ? "+" : preamp < 0 ? "−" : ""}
                {Math.abs(preamp).toFixed(1)} dB
              </span>
            </Row>
          </Section>

          <Separator />

          <Section title="Seek">
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
          </Section>

          <Separator />

          <Section title="Theme">
            <ThemePicker />
            <Row label="Accent from cover art">
              <Switch
                checked={config.coverAccent}
                disabled={!themeById(config.theme).coverAccent}
                onCheckedChange={(v) => setConfig({ coverAccent: v })}
              />
            </Row>
          </Section>

          <Separator />

          <Section title="Modules">
            <Row label="Listening history">
              <Switch checked={config.history} onCheckedChange={(v) => setConfig({ history: v })} />
            </Row>
            <Row label="Look up missing album and cover art (iTunes)">
              <Switch checked={config.metaOnline} onCheckedChange={(v) => setConfig({ metaOnline: v })} />
            </Row>
            <Row label="Download lyrics from LRCLIB">
              <Switch checked={config.lyricsOnline} onCheckedChange={(v) => setConfig({ lyricsOnline: v })} />
            </Row>
            <Row label="Discord Rich Presence">
              <Switch checked={config.discord} onCheckedChange={(v) => setConfig({ discord: v })} />
            </Row>
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
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
