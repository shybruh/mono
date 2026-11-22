// App-wide themes. Every colour in the UI derives from three base colours
// (see :root in index.css); a theme only decides those three, whether the
// accent may follow the cover art, and whether the deck uses mono type.

export interface ThemeColors {
  bg: string;
  fg: string;
  accent: string;
}

export interface ThemePreset extends ThemeColors {
  id: string;
  label: string;
  /** Accent may be replaced by the cover-art colour. */
  coverAccent: boolean;
  mono: boolean;
}

export const THEMES: ThemePreset[] = [
  { id: "zinc", label: "Zinc", bg: "#09090b", fg: "#e4e4e7", accent: "#a78bfa", coverAccent: true, mono: false },
  { id: "paper", label: "Paper", bg: "#f7f7f5", fg: "#1c1917", accent: "#7c3aed", coverAccent: true, mono: false },
  { id: "phosphor", label: "Phosphor", bg: "#030a05", fg: "#86efac", accent: "#4ade80", coverAccent: false, mono: true },
  { id: "amber", label: "Amber", bg: "#0c0a07", fg: "#fcd34d", accent: "#f59e0b", coverAccent: false, mono: true },
  { id: "custom", label: "Custom", bg: "#09090b", fg: "#e4e4e7", accent: "#a78bfa", coverAccent: true, mono: false },
];

export const themeById = (id: string) => THEMES.find((t) => t.id === id) ?? THEMES[0];

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance, 0..1. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const isHex = (v: string) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());

export interface ResolvedTheme {
  colors: ThemeColors;
  mono: boolean;
}

export function resolveTheme(
  id: string,
  custom: ThemeColors | null | undefined,
  coverHC: { h: number; c: number } | null,
  coverAccentOn: boolean,
): ResolvedTheme {
  const preset = themeById(id);
  const base: ThemeColors =
    id === "custom" && custom
      ? {
          bg: isHex(custom.bg) ? custom.bg : preset.bg,
          fg: isHex(custom.fg) ? custom.fg : preset.fg,
          accent: isHex(custom.accent) ? custom.accent : preset.accent,
        }
      : { bg: preset.bg, fg: preset.fg, accent: preset.accent };

  let accent = base.accent;
  if (coverAccentOn && preset.coverAccent && coverHC) {
    const dark = luminance(base.bg) < 0.4;
    // Near-greyscale covers keep the theme accent rather than turning grey.
    if (coverHC.c >= 0.05) accent = `oklch(${dark ? 0.72 : 0.52} ${coverHC.c} ${coverHC.h})`;
  }
  return { colors: { ...base, accent }, mono: preset.mono };
}

function accentForeground(accent: string, el: HTMLElement): string {
  // Resolve any CSS colour (oklch from cover art, hex) to rgb, then pick contrast.
  const probe = document.createElement("span");
  probe.style.color = accent;
  probe.style.display = "none";
  el.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
  probe.remove();
  const hex = "#" + rgb.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  return luminance(hex) > 0.35 ? "#0b0b0c" : "#fafafa";
}

export function applyTheme(t: ResolvedTheme) {
  const root = document.documentElement;
  root.style.setProperty("--base-bg", t.colors.bg);
  root.style.setProperty("--base-fg", t.colors.fg);
  root.style.setProperty("--base-accent", t.colors.accent);
  root.style.setProperty("--brand-foreground", accentForeground(t.colors.accent, document.body));
  root.style.setProperty("--theme-font", t.mono ? "var(--font-mono)" : "var(--font-sans)");
  root.classList.toggle("dark", luminance(t.colors.bg) < 0.4);
  root.style.colorScheme = luminance(t.colors.bg) < 0.4 ? "dark" : "light";
}
