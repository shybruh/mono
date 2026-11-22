import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Lyrics } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { cn, fmtTime } from "@/lib/utils";

// Tap-along lyric timing: press Enter / ↓ as each line starts, Backspace / ↑
// to undo. Saved as a standard .lrc next to the audio file.

/** Typical tap latency; stamps land slightly before the press. */
const REACTION = 0.15;

function stamp(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `[${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}]`;
}

export function LyricsSync({
  initial,
  onDone,
}: {
  initial: Lyrics | null;
  onDone: (saved: Lyrics | null) => void;
}) {
  const path = useStore((s) => s.track?.meta.path);
  const pos = useStore((s) => Math.round(s.pos * 10) / 10);
  const [text, setText] = useState(() => initial?.lines.map((l) => l.text).join("\n") ?? "");
  const [editing, setEditing] = useState(!initial?.lines.length);
  const lines = useMemo(() => text.split(/\r?\n/).map((l) => l.trim()), [text]);
  const [times, setTimes] = useState<(number | null)[]>([]);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const next = times.length;

  useEffect(() => {
    if (editing) return;
    const key = (e: KeyboardEvent) => {
      const tap = e.key === "Enter" || e.key === "ArrowDown";
      const undo = e.key === "Backspace" || e.key === "ArrowUp";
      if (!tap && !undo) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (tap && next < lines.length) {
        const t = Math.max(0, useStore.getState().pos - REACTION);
        setTimes((ts) => [...ts, t]);
      } else if (undo && next > 0) {
        setTimes((ts) => ts.slice(0, -1));
      }
    };
    // Capture phase so the app's own shortcuts don't also fire.
    window.addEventListener("keydown", key, { capture: true });
    return () => window.removeEventListener("keydown", key, { capture: true });
  }, [editing, next, lines.length]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-line="${next}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [next]);

  const save = async () => {
    if (!path) return;
    const lrc = lines
      .map((l, i) => (times[i] != null ? `${stamp(times[i]!)}${l}` : null))
      .filter(Boolean)
      .join("\n");
    try {
      onDone(await api.saveLrc(path, lrc + "\n"));
    } catch (e) {
      setError(String(e));
    }
  };

  if (editing) {
    return (
      <div className="flex h-full flex-col gap-3 py-6">
        <div className="text-[13px] text-muted-foreground">Lyrics, one line per line. Empty lines become instrumental gaps.</div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none rounded-lg border bg-background/60 p-3 text-[14px] leading-relaxed outline-none focus:border-ring"
          placeholder="Paste lyrics here"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!lines.some(Boolean)}
            onClick={() => {
              setTimes([]);
              setEditing(false);
            }}
            className="bg-brand text-brand-foreground hover:bg-brand-strong"
          >
            Start syncing
          </Button>
        </div>
      </div>
    );
  }

  const done = next >= lines.length;
  return (
    <div className="flex h-full flex-col gap-3 py-6">
      <div className="flex items-center justify-between gap-3 text-[12px] text-muted-foreground">
        <span>
          Press <kbd className="rounded border px-1 font-mono">Enter</kbd> as each line starts ·{" "}
          <kbd className="rounded border px-1 font-mono">Backspace</kbd> undo
        </span>
        <span className="font-mono tabular-nums">
          {fmtTime(pos)} · {Math.min(next, lines.length)}/{lines.length}
        </span>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto rounded-lg border bg-background/40 p-2">
        {lines.map((l, i) => (
          <div
            key={i}
            data-line={i}
            className={cn(
              "flex items-baseline gap-3 rounded-md px-2 py-1 text-[15px]",
              i === next && "bg-brand-wash text-brand",
              i < next && "text-muted-foreground",
              i > next && "text-foreground/60",
            )}
          >
            <span className="w-14 shrink-0 font-mono text-[11px] tabular-nums">
              {times[i] != null ? fmtTime(times[i]!) : ""}
            </span>
            <span className="min-w-0">{l || <span className="text-brand">♪</span>}</span>
          </div>
        ))}
      </div>
      {error && <p className="font-mono text-[11px] text-destructive">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Edit text
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTimes([]);
              api.seek(0);
            }}
          >
            Restart
          </Button>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={next === 0}
            onClick={save}
            className="bg-brand text-brand-foreground hover:bg-brand-strong"
          >
            {done ? "Save .lrc" : `Save ${next} lines`}
          </Button>
        </div>
      </div>
    </div>
  );
}
