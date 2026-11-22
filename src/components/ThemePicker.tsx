import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useStore, refreshTheme } from "@/lib/store";
import { THEMES, isHex, themeById, type ThemeColors } from "@/lib/theme";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

let persistTimer: number | undefined;

/** Applies custom colours live and persists them shortly after the last change. */
function setCustom(next: ThemeColors) {
  const c = useStore.getState().config;
  if (!c) return;
  useStore.setState({ config: { ...c, theme: "custom", customTheme: next } });
  refreshTheme();
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    useStore.getState().setConfig({ theme: "custom", customTheme: next });
  }, 350);
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setText(value), [value]);
  return (
    <div className="flex min-h-9 items-center justify-between gap-6">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`${label} colour`}
          onClick={() => input.current?.click()}
          className="relative size-7 rounded-md border"
          style={{ background: value }}
        >
          <input
            ref={input}
            type="color"
            value={isHex(value) && value.length === 7 ? value : "#000000"}
            onChange={(e) => onChange(e.target.value)}
            className="pointer-events-none absolute inset-0 opacity-0"
            tabIndex={-1}
          />
        </button>
        <input
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            if (isHex(e.target.value)) onChange(e.target.value);
          }}
          onBlur={() => setText(value)}
          className="h-8 w-24 rounded-md border bg-transparent px-2 font-mono text-[12px] uppercase outline-none focus:border-ring"
        />
      </div>
    </div>
  );
}

export function ThemePicker() {
  const config = useStore((s) => s.config);
  if (!config) return null;
  const active = config.theme;

  const choose = (id: string) => {
    if (id !== "custom") return useStore.getState().setConfig({ theme: id });
    // First time on Custom: start from whatever theme is showing now.
    const def = themeById("custom");
    const untouched =
      config.customTheme.bg === def.bg && config.customTheme.fg === def.fg && config.customTheme.accent === def.accent;
    const from = themeById(active);
    useStore.getState().setConfig({
      theme: "custom",
      customTheme:
        untouched && active !== "custom"
          ? { bg: from.bg, fg: from.fg, accent: from.accent, glass: !!from.glass }
          : config.customTheme,
    });
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-7 gap-2">
        {THEMES.map((t) => {
          const colors: ThemeColors = t.id === "custom" ? config.customTheme : t;
          const on = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => choose(t.id)}
              className={cn(
                "group flex flex-col items-center gap-1.5 rounded-lg p-1 text-[11px] text-muted-foreground hover:text-foreground",
                on && "text-foreground",
              )}
            >
              <span
                className={cn(
                  "relative flex h-12 w-full items-end justify-between overflow-hidden rounded-md border p-1.5 transition-shadow",
                  on && "ring-2 ring-brand ring-offset-2 ring-offset-background",
                )}
                style={{
                  // Glass swatches hint at translucency with a soft tinted sheen.
                  background: colors.glass
                    ? `linear-gradient(135deg, ${colors.accent}66, ${colors.bg}d9 45%, ${colors.bg}b3 70%, ${colors.fg}33)`
                    : colors.bg,
                }}
              >
                <span
                  className="text-[13px] leading-none font-medium"
                  style={{ color: colors.fg, fontFamily: t.mono ? "var(--font-mono)" : undefined }}
                >
                  Aa
                </span>
                <span className="size-2.5 rounded-full" style={{ background: colors.accent }} />
                {on && (
                  <Check
                    className="absolute top-1 right-1 size-3"
                    style={{ color: colors.fg }}
                  />
                )}
              </span>
              {t.label}
            </button>
          );
        })}
      </div>
      {active === "custom" && (
        <div className="pt-1">
          <ColorField
            label="Background"
            value={config.customTheme.bg}
            onChange={(bg) => setCustom({ ...config.customTheme, bg })}
          />
          <ColorField
            label="Text"
            value={config.customTheme.fg}
            onChange={(fg) => setCustom({ ...config.customTheme, fg })}
          />
          <ColorField
            label="Accent"
            value={config.customTheme.accent}
            onChange={(accent) => setCustom({ ...config.customTheme, accent })}
          />
          <div className="flex min-h-9 items-center justify-between gap-6">
            <span className="text-[13px] text-muted-foreground">Translucent</span>
            <Switch
              checked={!!config.customTheme.glass}
              onCheckedChange={(glass) => setCustom({ ...config.customTheme, glass })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
