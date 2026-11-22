import { useEffect, useMemo, useRef, useState } from "react";
import { Power, Trash2 } from "lucide-react";
import { api, type Config } from "@/lib/api";
import { useStore } from "@/lib/store";
import { useMeterCanvas, useMeters } from "@/hooks/useMeters";
import { resolveColor } from "@/lib/accent";
import {
  F_MAX,
  F_MIN,
  KIND_LABEL,
  MAX_BANDS,
  PRESETS,
  bandResponse,
  fmtFreq,
  hasGain,
  isCut,
  logFreqs,
  newBand,
  parseFreq,
  totalResponse,
  type BandKind,
  type EqBand,
  type EqSettings,
} from "@/lib/eq";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const RANGE = 18; // ± dB shown
const GRID_F = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const LABEL_F = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const CURVE = logFreqs(360);
const CROSSFEED: [string, number][] = [
  ["Off", 0],
  ["Low", 0.3],
  ["Medium", 0.5],
  ["High", 0.7],
];

const hueOf = (i: number) => (i * 47 + 255) % 360;
const colorOf = (i: number, alpha = 1) => `oklch(0.78 0.14 ${hueOf(i)} / ${alpha})`;

let persistTimer: number | undefined;
/** Applies to the UI immediately; the engine and disk follow a moment later. */
function update(patch: Partial<Config>) {
  const c = useStore.getState().config;
  if (!c) return;
  useStore.setState({ config: { ...c, ...patch } });
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    const cur = useStore.getState().config;
    if (cur) api.updateConfig({ eq: cur.eq, crossfeed: cur.crossfeed, crossfade: cur.crossfade });
  }, 50);
}

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 800, h: 320 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Live spectrum behind the curve. */
function Analyzer() {
  const ref = useRef<HTMLCanvasElement>(null);
  const meters = useMeters();
  useMeterCanvas(ref, (ctx, w, h, el) => {
    const s = meters.current.current?.spectrum;
    if (!s?.length) return;
    const lo = Math.log(20);
    const hi = Math.log(20000);
    const span = Math.log(F_MAX / F_MIN);
    ctx.beginPath();
    ctx.moveTo(0, h);
    s.forEach((v, b) => {
      const f = Math.exp(lo + ((hi - lo) * (b + 0.5)) / s.length);
      const x = (Math.log(f / F_MIN) / span) * w;
      ctx.lineTo(x, h - v * h * 0.92);
    });
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = resolveColor(el.parentElement!, "color-mix(in oklch, var(--foreground) 10%, transparent)");
    ctx.fill();
  });
  return <canvas ref={ref} className="pointer-events-none absolute inset-0 block size-full" />;
}

function Graph({
  eq,
  selected,
  onSelect,
}: {
  eq: EqSettings;
  selected: number | null;
  onSelect: (i: number | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(box);
  const [dragging, setDragging] = useState(false);
  const span = Math.log(F_MAX / F_MIN);
  const fx = (f: number) => (Math.log(f / F_MIN) / span) * w;
  const xf = (x: number) => Math.min(F_MAX, Math.max(F_MIN, F_MIN * Math.exp((x / w) * span)));
  const pad = 14;
  const gy = (db: number) => h / 2 - (db / RANGE) * (h / 2 - pad);
  const yg = (y: number) => Math.max(-RANGE, Math.min(RANGE, ((h / 2 - y) / (h / 2 - pad)) * RANGE));

  const total = useMemo(() => totalResponse(eq, CURVE), [eq]);
  const path = (dbs: number[]) =>
    dbs.map((d, i) => `${i ? "L" : "M"}${fx(CURVE[i]).toFixed(1)},${gy(Math.max(-RANGE - 6, Math.min(RANGE + 6, d))).toFixed(1)}`).join("");
  const sel = selected != null ? eq.bands[selected] : null;
  const selCurve = useMemo(() => (sel && sel.enabled ? bandResponse(sel, CURVE) : null), [sel]);

  const setBand = (i: number, patch: Partial<EqBand>) =>
    update({ eq: { ...eq, bands: eq.bands.map((b, k) => (k === i ? { ...b, ...patch } : b)) } });

  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div
      ref={box}
      className="relative h-[320px] overflow-hidden rounded-lg border bg-background/40 select-none"
      onDoubleClick={(e) => {
        if (eq.bands.length >= MAX_BANDS || (e.target as Element).closest("[data-node]")) return;
        const { x, y } = local(e);
        const bands = [...eq.bands, newBand(Math.round(xf(x)), Math.round(yg(y) * 10) / 10)];
        update({ eq: { ...eq, enabled: true, bands } });
        onSelect(bands.length - 1);
      }}
      onPointerDown={(e) => {
        if (!(e.target as Element).closest("[data-node]")) onSelect(null);
      }}
      onWheel={(e) => {
        if (selected == null || !sel) return;
        const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        setBand(selected, { q: Math.round(Math.max(0.1, Math.min(18, sel.q * k)) * 100) / 100 });
      }}
    >
      <Analyzer />
      <svg className="absolute inset-0 size-full" width={w} height={h}>
        {GRID_F.map((f) => (
          <line key={f} x1={fx(f)} x2={fx(f)} y1={0} y2={h} className="stroke-border" strokeWidth={1} />
        ))}
        {[-12, -6, 6, 12].map((d) => (
          <line key={d} x1={0} x2={w} y1={gy(d)} y2={gy(d)} className="stroke-border" strokeWidth={1} strokeDasharray="2 4" />
        ))}
        <line x1={0} x2={w} y1={gy(0)} y2={gy(0)} className="stroke-border" strokeWidth={1.5} />
        {[-12, -6, 6, 12].map((d) => (
          <text key={d} x={w - 6} y={gy(d) - 3} textAnchor="end" className="fill-muted-foreground/60 font-mono text-[10px]">
            {d > 0 ? `+${d}` : d}
          </text>
        ))}
        {LABEL_F.map((f) => (
          <text key={f} x={Math.min(w - 4, Math.max(4, fx(f)))} y={h - 5} textAnchor="middle" className="fill-muted-foreground/60 font-mono text-[10px]">
            {f >= 1000 ? `${f / 1000}k` : f}
          </text>
        ))}

        {selCurve && selected != null && (
          <path d={path(selCurve) + `L${w},${gy(0)}L0,${gy(0)}Z`} fill={colorOf(selected, 0.16)} stroke={colorOf(selected, 0.7)} strokeWidth={1} />
        )}
        <path
          d={path(total)}
          fill="none"
          strokeWidth={2.25}
          className={cn(eq.enabled ? "stroke-brand" : "stroke-muted-foreground/50")}
          strokeLinejoin="round"
        />

        {eq.bands.map((b, i) => {
          const x = fx(b.freq);
          const y = hasGain(b.kind) ? gy(b.gain) : gy(0);
          const on = i === selected;
          return (
            <g
              key={i}
              data-node
              transform={`translate(${x},${y})`}
              className={dragging ? "cursor-grabbing" : "cursor-grab"}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (e.button !== 0) {
                  onSelect(i);
                  return;
                }
                e.preventDefault();
                onSelect(i);
                // Press and drag in one gesture: follow the pointer until release.
                const move = (ev: PointerEvent) => {
                  const r = box.current!.getBoundingClientRect();
                  const x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
                  const cur = useStore.getState().config?.eq;
                  if (!cur?.bands[i]) return;
                  const b = cur.bands[i];
                  update({
                    eq: {
                      ...cur,
                      bands: cur.bands.map((x2, k) =>
                        k === i
                          ? {
                              ...x2,
                              freq: Math.round(xf(x)),
                              ...(hasGain(b.kind) ? { gain: Math.round(yg(ev.clientY - r.top) * 10) / 10 } : {}),
                            }
                          : x2,
                      ),
                    },
                  });
                };
                const up = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                  window.removeEventListener("pointercancel", up);
                  setDragging(false);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
                window.addEventListener("pointercancel", up);
                setDragging(true);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onSelect(i);
              }}
            >
              <circle r={on ? 9 : 7} fill={b.enabled ? colorOf(i) : "var(--muted)"} stroke={on ? "var(--foreground)" : "var(--background)"} strokeWidth={2} />
              <text y={3.5} textAnchor="middle" className="pointer-events-none fill-background font-mono text-[9px] font-semibold">
                {i + 1}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function NumberField({
  label,
  value,
  format,
  parse,
  disabled,
}: {
  label: string;
  value: number;
  format: (v: number) => string;
  parse: (s: string) => number | null;
  disabled?: boolean;
}) {
  const [text, setText] = useState(format(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(format(value));
  }, [value, editing, format]);
  const commit = () => {
    setEditing(false);
    const v = parse(text);
    if (v == null) setText(format(value));
  };
  return (
    <label className={cn("flex flex-col gap-1", disabled && "opacity-40")}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        disabled={disabled}
        value={text}
        onFocus={() => setEditing(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        className="h-8 w-24 rounded-md border bg-transparent px-2 font-mono text-[12px] outline-none focus:border-ring"
      />
    </label>
  );
}

function BandEditor({ eq, index, onDelete }: { eq: EqSettings; index: number; onDelete: () => void }) {
  const b = eq.bands[index];
  const set = (patch: Partial<EqBand>) =>
    update({ eq: { ...eq, bands: eq.bands.map((x, k) => (k === index ? { ...x, ...patch } : x)) } });
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="flex items-center gap-2 self-center">
        <span className="size-3 rounded-full" style={{ background: colorOf(index) }} />
        <span className="font-mono text-[12px]">Band {index + 1}</span>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">Type</span>
        <Select
          value={b.kind}
          onValueChange={(v) => {
            const kind = v as BandKind;
            set({ kind, q: kind === "bell" || kind === "notch" ? (b.kind === "bell" ? b.q : 1) : 0.707 });
          }}
        >
          <SelectTrigger size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(KIND_LABEL) as BandKind[]).map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <NumberField
        label="Frequency"
        value={b.freq}
        format={fmtFreq}
        parse={(s) => {
          const f = parseFreq(s);
          if (f != null) set({ freq: Math.round(f) });
          return f;
        }}
      />
      <NumberField
        label="Gain"
        value={b.gain}
        disabled={!hasGain(b.kind)}
        format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`}
        parse={(s) => {
          const v = parseFloat(s.replace(/[^\d.+-]/g, ""));
          if (!Number.isFinite(v)) return null;
          set({ gain: Math.max(-RANGE, Math.min(RANGE, v)) });
          return v;
        }}
      />
      <NumberField
        label="Q"
        value={b.q}
        format={(v) => v.toFixed(2)}
        parse={(s) => {
          const v = parseFloat(s);
          if (!Number.isFinite(v)) return null;
          set({ q: Math.max(0.1, Math.min(18, v)) });
          return v;
        }}
      />
      {isCut(b.kind) && (
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Slope</span>
          <Select value={String(b.slope)} onValueChange={(v) => set({ slope: Number(v) as EqBand["slope"] })}>
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[12, 24, 48].map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s} dB/oct
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      )}
      <div className="ml-auto flex items-center gap-1 self-center">
        <button
          title={b.enabled ? "Bypass band" : "Enable band"}
          onClick={() => set({ enabled: !b.enabled })}
          className={cn("rounded-md p-1.5 hover:bg-accent [&_svg]:size-4", b.enabled ? "text-foreground" : "text-muted-foreground")}
        >
          <Power />
        </button>
        <button title="Delete band" onClick={onDelete} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4">
          <Trash2 />
        </button>
      </div>
    </div>
  );
}

export function ParametricEq() {
  const open = useStore((s) => s.eqOpen);
  const config = useStore((s) => s.config);
  const [selected, setSelected] = useState<number | null>(null);

  const eq = config?.eq;
  const del = (i: number) => {
    if (!eq) return;
    update({ eq: { ...eq, bands: eq.bands.filter((_, k) => k !== i) } });
    setSelected(null);
  };

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [role=combobox]")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected != null) {
        e.preventDefault();
        del(selected);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  if (!config || !eq) return null;
  const preset = Object.entries(PRESETS).find(
    ([, bands]) => JSON.stringify(bands) === JSON.stringify(eq.bands),
  )?.[0];

  return (
    <Dialog open={open} onOpenChange={(v) => useStore.getState().setEqOpen(v)}>
      <DialogContent className="gap-0 p-0 sm:max-w-[960px]">
        <div className="flex items-center justify-between gap-4 border-b px-5 py-3">
          <div className="flex items-center gap-3">
            <DialogTitle className="text-sm font-medium">Equaliser</DialogTitle>
            <DialogDescription className="sr-only">Parametric equaliser</DialogDescription>
            <Switch checked={eq.enabled} onCheckedChange={(v) => update({ eq: { ...eq, enabled: v } })} />
          </div>
          <div className="mr-8 flex items-center gap-2">
            <span className="text-[12px] text-muted-foreground">Preset</span>
            <Select
              value={preset ?? ""}
              onValueChange={(name) => {
                update({ eq: { ...eq, enabled: true, bands: structuredClone(PRESETS[name]) } });
                setSelected(null);
              }}
            >
              <SelectTrigger size="sm" className="w-36">
                <SelectValue placeholder="Custom" />
              </SelectTrigger>
              <SelectContent>
                {Object.keys(PRESETS).map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className={cn("space-y-4 px-5 py-4", !eq.enabled && "[&_.stroke-brand]:opacity-50")}>
          <Graph eq={eq} selected={selected} onSelect={setSelected} />
          <div className="flex min-h-[60px] items-center">
            {selected != null && eq.bands[selected] ? (
              <div className="w-full">
                <BandEditor eq={eq} index={selected} onDelete={() => del(selected)} />
              </div>
            ) : (
              <div className="flex w-full flex-wrap items-center gap-1.5">
                {eq.bands.map((b, i) => (
                  <button
                    key={i}
                    onClick={() => setSelected(i)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] hover:bg-accent",
                      !b.enabled && "opacity-50",
                    )}
                  >
                    <span className="size-2 rounded-full" style={{ background: colorOf(i) }} />
                    {KIND_LABEL[b.kind]} {fmtFreq(b.freq)}
                    {hasGain(b.kind) ? ` ${b.gain > 0 ? "+" : ""}${b.gain.toFixed(1)}` : ""}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-6 border-t px-5 py-4">
          <label className="flex flex-col gap-2">
            <span className="flex justify-between text-[12px] text-muted-foreground">
              Pre-amp
              <span className="font-mono tabular-nums text-foreground">
                {eq.preamp > 0 ? "+" : ""}
                {eq.preamp.toFixed(1)} dB
              </span>
            </span>
            <Slider
              min={-18}
              max={6}
              step={0.5}
              value={[eq.preamp]}
              onValueChange={([v]) => update({ eq: { ...eq, preamp: v } })}
              onDoubleClick={() => update({ eq: { ...eq, preamp: 0 } })}
            />
          </label>
          <div className="flex flex-col gap-2">
            <span className="text-[12px] text-muted-foreground">Crossfeed</span>
            <div className="flex gap-1">
              {CROSSFEED.map(([name, v]) => (
                <button
                  key={name}
                  onClick={() => update({ crossfeed: v })}
                  className={cn(
                    "flex-1 rounded-md border py-1 text-[11px] text-muted-foreground hover:text-foreground",
                    Math.abs(config.crossfeed - v) < 0.01 && "border-brand text-brand",
                  )}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-2">
            <span className="flex justify-between text-[12px] text-muted-foreground">
              Crossfade
              <span className="font-mono tabular-nums text-foreground">
                {config.crossfade > 0 ? `${config.crossfade.toFixed(1)} s` : "Gapless"}
              </span>
            </span>
            <Slider min={0} max={12} step={0.5} value={[config.crossfade]} onValueChange={([v]) => update({ crossfade: v })} />
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
