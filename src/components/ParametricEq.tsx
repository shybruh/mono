import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Power, Save, Trash2 } from "lucide-react";
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
  sameCurve,
  totalResponse,
  type BandKind,
  type EqBand,
  type EqPreset,
  type EqSettings,
} from "@/lib/eq";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectLabel, SelectGroup, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
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

function savePresets(eqPresets: EqPreset[]) {
  const c = useStore.getState().config;
  if (!c) return;
  useStore.setState({ config: { ...c, eqPresets } });
  api.updateConfig({ eqPresets });
}

type Curve = Pick<EqSettings, "preamp" | "bands">;
/** A/B compare: the slot not being edited. Lives for the session, like the plug-in it's modelled on. */
const ab: { slot: "a" | "b"; other: Curve | null } = { slot: "a", other: null };

function SavePreset({ eq, initial }: { eq: EqSettings; initial: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initial);
  const save = () => {
    const n = name.trim();
    if (!n) return;
    const list = useStore.getState().config?.eqPresets ?? [];
    const entry: EqPreset = { name: n, preamp: eq.preamp, bands: structuredClone(eq.bands) };
    const at = list.findIndex((p) => p.name.toLowerCase() === n.toLowerCase());
    savePresets(at >= 0 ? list.map((p, i) => (i === at ? entry : p)) : [...list, entry]);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setName(initial);
      }}
    >
      <PopoverTrigger asChild>
        <button title="Save preset" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4">
          <Save />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            autoFocus
            value={name}
            placeholder="Preset name"
            onChange={(e) => setName(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-[12px] outline-none focus:border-ring"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="h-8 rounded-md bg-brand px-3 text-[12px] font-medium text-brand-foreground hover:bg-brand-strong disabled:opacity-40"
          >
            Save
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function AbSwitch({ eq, onSwitch }: { eq: EqSettings; onSwitch: () => void }) {
  const [slot, setSlot] = useState(ab.slot);
  const [copied, setCopied] = useState(0);
  const go = (s: "a" | "b") => {
    if (s === ab.slot) return;
    const cur: Curve = { preamp: eq.preamp, bands: eq.bands };
    const next = ab.other ?? { preamp: eq.preamp, bands: structuredClone(eq.bands) };
    ab.other = cur;
    ab.slot = s;
    setSlot(s);
    update({ eq: { ...eq, preamp: next.preamp, bands: next.bands } });
    onSwitch();
  };
  const other = slot === "a" ? "B" : "A";
  return (
    <div className="flex items-center gap-1">
      <div className="relative flex rounded-md border p-0.5">
        <span
          className="absolute inset-y-0.5 left-0.5 w-7 rounded-[5px] bg-accent transition-transform duration-200 ease-[var(--ease-out-expo)]"
          style={{ transform: `translateX(${slot === "a" ? 0 : 28}px)` }}
        />
        {(["a", "b"] as const).map((s) => (
          <button
            key={s}
            onClick={() => go(s)}
            className={cn(
              "relative h-6 w-7 font-mono text-[11px] font-semibold uppercase",
              slot === s ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s}
          </button>
        ))}
      </div>
      <button
        title={`Copy ${slot.toUpperCase()} to ${other}`}
        onClick={() => {
          ab.other = { preamp: eq.preamp, bands: structuredClone(eq.bands) };
          setCopied((n) => n + 1);
        }}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4"
      >
        <Copy key={copied} className={copied ? "animate-pop" : undefined} />
      </button>
    </div>
  );
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
  removing,
}: {
  eq: EqSettings;
  selected: number | null;
  onSelect: (i: number | null) => void;
  removing: number | null;
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

  // The curve shows the bands alone (as nodes sit at their own gain); pre-amp is a separate output gain.
  const total = useMemo(() => totalResponse({ ...eq, preamp: 0 }, CURVE), [eq]);
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
          style={{ transition: dragging ? "none" : "d 220ms var(--ease-out-expo)" }}
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
              className={cn("group/node", dragging ? "cursor-grabbing" : "cursor-grab")}
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
              <g
                style={{
                  animation:
                    i === removing
                      ? "node-out 160ms var(--ease-out-expo) forwards"
                      : "node-in 320ms var(--ease-spring) both",
                }}
              >
                <circle
                  fill={b.enabled ? colorOf(i) : "var(--muted)"}
                  stroke={on ? "var(--foreground)" : "var(--background)"}
                  strokeWidth={2}
                  className={cn(
                    "transition-[r,fill,stroke] duration-200 ease-[var(--ease-spring)]",
                    on ? "[r:9px] group-hover/node:[r:10.5px]" : "[r:7px] group-hover/node:[r:9px]",
                    dragging && on && "[r:10.5px]",
                  )}
                />
                <text y={3.5} textAnchor="middle" className="pointer-events-none fill-background font-mono text-[9px] font-semibold">
                  {i + 1}
                </text>
              </g>
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
  const [removing, setRemoving] = useState<number | null>(null);

  const eq = config?.eq;
  // Shrink the node out, then drop the band.
  const del = (i: number) => {
    if (!eq || removing != null) return;
    setSelected(null);
    setRemoving(i);
    window.setTimeout(() => {
      const cur = useStore.getState().config?.eq;
      if (cur) update({ eq: { ...cur, bands: cur.bands.filter((_, k) => k !== i) } });
      setRemoving(null);
    }, 150);
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
  const saved = config.eqPresets ?? [];
  const mine = saved.find((p) => sameCurve(p, eq));
  const builtin = Object.entries(PRESETS).find(([, bands]) => JSON.stringify(bands) === JSON.stringify(eq.bands))?.[0];
  const preset = mine ? `u:${mine.name}` : builtin ? `b:${builtin}` : "";

  return (
    <Dialog open={open} onOpenChange={(v) => useStore.getState().setEqOpen(v)}>
      <DialogContent className="gap-0 p-0 sm:max-w-[960px]">
        <div className="flex items-center justify-between gap-4 border-b px-5 py-3">
          <div className="flex items-center gap-3">
            <DialogTitle className="text-sm font-medium">Equaliser</DialogTitle>
            <DialogDescription className="sr-only">Parametric equaliser</DialogDescription>
            <Switch checked={eq.enabled} onCheckedChange={(v) => update({ eq: { ...eq, enabled: v } })} />
          </div>
          <div className="mr-8 flex items-center gap-3">
            <AbSwitch eq={eq} onSwitch={() => setSelected(null)} />
            <div className="h-5 w-px bg-border" />
            <div className="flex items-center gap-1">
              <Select
                value={preset}
                onValueChange={(v) => {
                  const name = v.slice(2);
                  if (v.startsWith("u:")) {
                    const p = saved.find((x) => x.name === name);
                    if (p) update({ eq: { ...eq, enabled: true, preamp: p.preamp, bands: structuredClone(p.bands) } });
                  } else {
                    update({ eq: { ...eq, enabled: true, bands: structuredClone(PRESETS[name]) } });
                  }
                  setSelected(null);
                }}
              >
                <SelectTrigger size="sm" className="w-40">
                  <SelectValue placeholder="Custom" />
                </SelectTrigger>
                <SelectContent>
                  {saved.length > 0 && (
                    <>
                      <SelectGroup>
                        <SelectLabel>Saved</SelectLabel>
                        {saved.map((p) => (
                          <SelectItem key={p.name} value={`u:${p.name}`}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                      <SelectSeparator />
                    </>
                  )}
                  <SelectGroup>
                    {saved.length > 0 && <SelectLabel>Built-in</SelectLabel>}
                    {Object.keys(PRESETS).map((name) => (
                      <SelectItem key={name} value={`b:${name}`}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <SavePreset eq={eq} initial={mine?.name ?? ""} />
              {mine && (
                <button
                  title="Delete preset"
                  onClick={() => savePresets(saved.filter((p) => p !== mine))}
                  className="animate-pop rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4"
                >
                  <Trash2 />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className={cn("space-y-4 px-5 py-4", !eq.enabled && "[&_.stroke-brand]:opacity-50")}>
          <Graph eq={eq} selected={selected} onSelect={setSelected} removing={removing} />
          <div className="flex min-h-[60px] items-center">
            {selected != null && eq.bands[selected] ? (
              <div key={selected} className="w-full animate-fade">
                <BandEditor eq={eq} index={selected} onDelete={() => del(selected)} />
              </div>
            ) : (
              <div className="flex w-full animate-fade flex-wrap items-center gap-1.5">
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
