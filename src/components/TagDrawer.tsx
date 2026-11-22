import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ImageUp, Loader2, Search, Trash2 } from "lucide-react";
import { fetchArtwork, search, type Match } from "@/lib/itunes";
import { basename, cn, fmtTime } from "@/lib/utils";
import { api, type TagEdit, type TrackMeta } from "@/lib/api";
import { useStore } from "@/lib/store";
import { keyToTag, parseKey } from "@/lib/keys";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type FieldId = keyof TagEdit;
type Form = Record<FieldId, string>;

const FIELDS: FieldId[] = [
  "title",
  "artist",
  "album",
  "albumArtist",
  "genre",
  "year",
  "track",
  "trackTotal",
  "disc",
  "bpm",
  "key",
];
const NUMERIC: FieldId[] = ["year", "track", "trackTotal", "disc", "bpm"];

const blank = () => Object.fromEntries(FIELDS.map((f) => [f, ""])) as Form;

function fromMeta(m: TrackMeta): Form {
  const s = (v: unknown) => (v == null ? "" : String(v));
  return {
    title: m.title,
    artist: s(m.artist),
    album: s(m.album),
    albumArtist: s(m.albumArtist),
    genre: s(m.genre),
    year: s(m.year),
    track: s(m.track),
    trackTotal: s(m.trackTotal),
    disc: s(m.disc),
    bpm: m.bpm ? String(Math.round(m.bpm * 10) / 10) : "",
    key: m.key ?? "",
  };
}

function toEdit(f: Form): TagEdit {
  const int = (v: string) => (v.trim() && Number.isFinite(+v) ? Math.trunc(+v) : null);
  const bpm = parseFloat(f.bpm);
  const key = parseKey(f.key);
  return {
    title: f.title,
    artist: f.artist,
    album: f.album,
    albumArtist: f.albumArtist,
    genre: f.genre,
    year: int(f.year),
    track: int(f.track),
    trackTotal: int(f.trackTotal),
    disc: int(f.disc),
    bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
    key: key ? keyToTag(key) : f.key.trim() || null,
  };
}

function Field({
  id,
  label,
  form,
  mixed,
  onChange,
  className,
}: {
  id: FieldId;
  label: string;
  form: Form;
  mixed: boolean;
  onChange: (id: FieldId, v: string) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label htmlFor={id} className="mb-1.5 text-[11px] font-normal text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        value={form[id]}
        placeholder={mixed ? "Mixed" : undefined}
        onChange={(e) => onChange(id, e.target.value)}
        className="h-8 font-mono text-[12px] placeholder:italic"
        inputMode={NUMERIC.includes(id) ? "decimal" : undefined}
      />
    </div>
  );
}

export function TagDrawer() {
  const paths = useStore((s) => s.tagTarget);
  const [metas, setMetas] = useState<TrackMeta[]>([]);
  const [form, setForm] = useState<Form>(blank);
  const [touched, setTouched] = useState<Set<FieldId>>(new Set());
  const [cover, setCover] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [looking, setLooking] = useState(false);
  const [stagedArt, setStagedArt] = useState<string | null>(null);

  const single = paths?.length === 1;
  const key = paths?.join("\n") ?? "";

  /** Common value per field, "" where the tracks differ. */
  const base = useMemo(() => {
    const out = blank();
    const mixed = new Set<FieldId>();
    if (!metas.length) return { form: out, mixed };
    const forms = metas.map(fromMeta);
    for (const f of FIELDS) {
      const v = forms[0][f];
      if (forms.every((x) => x[f] === v)) out[f] = v;
      else mixed.add(f);
    }
    return { form: out, mixed };
  }, [metas]);

  const load = async (ps: string[]) => {
    const ms = await Promise.all(ps.map((p) => api.trackMeta(p)));
    setMetas(ms);
    setTouched(new Set());
    setCover(ps.length === 1 ? await api.cover(ps[0]) : null);
    setError(null);
  };

  useEffect(() => {
    setMatches(null);
    setStagedArt(null);
    setMetas([]);
    if (paths) load(paths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => setForm(base.form), [base]);

  const change = (id: FieldId, v: string) => {
    setForm((f) => ({ ...f, [id]: v }));
    setTouched((t) => new Set(t).add(id));
  };

  const lookUp = async () => {
    setLooking(true);
    setError(null);
    try {
      const list = await search(form.artist, form.title, metas[0]?.duration ?? 0);
      setMatches(list.slice(0, 8));
    } catch {
      setError("iTunes lookup failed");
    } finally {
      setLooking(false);
    }
  };

  const apply = (m: Match) => {
    const s = (v: unknown) => (v == null ? "" : String(v));
    const patch: Partial<Form> = {
      title: m.title,
      artist: m.artist,
      album: m.album,
      albumArtist: m.albumArtist ?? "",
      genre: m.genre ?? "",
      year: s(m.year),
      track: s(m.track),
      trackTotal: s(m.trackTotal),
      disc: s(m.disc),
    };
    const next = { ...form };
    const t = new Set(touched);
    for (const [k, v] of Object.entries(patch) as [FieldId, string][]) {
      if (v) {
        next[k] = v;
        t.add(k);
      }
    }
    setForm(next);
    setTouched(t);
    if (m.artwork) setStagedArt(m.artwork);
    setMatches(null);
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (paths) await load(paths);
      useStore.getState().reloadList();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      // Each file keeps its own values for fields that weren't edited.
      for (const m of metas) {
        const merged = fromMeta(m);
        for (const f of touched) merged[f] = form[f];
        await api.writeTags(m.path, toEdit(merged));
      }
      if (stagedArt && paths) {
        const art = await fetchArtwork(stagedArt);
        for (const p of paths) await api.setCoverData(p, art.data, art.mime);
        setStagedArt(null);
      }
    });

  const inferred = single && metas[0]?.inferred;
  const dirty = touched.size > 0 || stagedArt != null || !!inferred;
  const anyCover = metas.some((m) => m.hasCover);
  const mixed = (f: FieldId) => base.mixed.has(f) && !touched.has(f);
  const fieldProps = { form, onChange: change };

  return (
    <Sheet open={paths != null} onOpenChange={(v) => !v && useStore.getState().openTags(null)}>
      <SheetContent className="w-[380px] gap-0 sm:max-w-[380px]">
        <SheetHeader className="border-b">
          <SheetTitle className="text-sm font-medium">{single ? "Tags" : `Tags · ${paths?.length ?? 0} tracks`}</SheetTitle>
          <SheetDescription className="truncate font-mono text-[11px]">
            {single && paths ? basename(paths[0]) : "Edited fields apply to every selected track"}
          </SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <div className="flex items-end gap-3">
              <div className="size-28 shrink-0 overflow-hidden rounded-lg bg-brand-wash">
                {(stagedArt ?? cover) && (
                  <img src={stagedArt ?? cover!} alt="" className="size-full object-cover" draggable={false} />
                )}
              </div>
              <div className="flex flex-col gap-2">
                {single && (
                  <Button type="button" variant="outline" size="sm" disabled={busy || looking} onClick={lookUp}>
                    {looking ? <Loader2 className="animate-spin" /> : <Search />} Look up
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    const img = await open({
                      multiple: false,
                      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "gif", "bmp"] }],
                    });
                    if (typeof img === "string" && paths) run(async () => {
                      for (const p of paths) await api.setCover(p, img);
                    });
                  }}
                >
                  <ImageUp /> Replace
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || !anyCover}
                  onClick={() =>
                    paths &&
                    run(async () => {
                      for (const p of paths) await api.removeCover(p);
                    })
                  }
                >
                  <Trash2 /> Remove
                </Button>
              </div>
            </div>
            {matches && (
              <div className="rounded-lg border">
                {matches.length === 0 && (
                  <div className="px-3 py-2.5 text-[12px] text-muted-foreground">No matches</div>
                )}
                {matches.map((m, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => apply(m)}
                    className="flex w-full items-center gap-2.5 border-b px-2 py-1.5 text-left last:border-0 hover:bg-accent"
                  >
                    <img src={m.thumb} alt="" className="size-10 shrink-0 rounded" draggable={false} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-foreground">{m.title}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {m.artist} · {m.album}
                      </span>
                    </span>
                    <span className="shrink-0 text-right font-mono text-[10px] leading-tight text-muted-foreground">
                      {m.year ?? ""}
                      <br />
                      {m.duration ? fmtTime(m.duration) : ""}
                    </span>
                    <span
                      title={`${Math.round(m.score * 100)}% match`}
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        m.score >= 0.72 ? "bg-brand" : m.score >= 0.45 ? "bg-muted-foreground" : "bg-border",
                      )}
                    />
                  </button>
                ))}
              </div>
            )}
            <Field id="title" label="Title" mixed={mixed("title")} {...fieldProps} />
            <Field id="artist" label="Artist" mixed={mixed("artist")} {...fieldProps} />
            <Field id="album" label="Album" mixed={mixed("album")} {...fieldProps} />
            <Field id="albumArtist" label="Album artist" mixed={mixed("albumArtist")} {...fieldProps} />
            <div className="grid grid-cols-2 gap-3">
              <Field id="genre" label="Genre" mixed={mixed("genre")} {...fieldProps} />
              <Field id="year" label="Year" mixed={mixed("year")} {...fieldProps} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field id="track" label="Track" mixed={mixed("track")} {...fieldProps} />
              <Field id="trackTotal" label="Of" mixed={mixed("trackTotal")} {...fieldProps} />
              <Field id="disc" label="Disc" mixed={mixed("disc")} {...fieldProps} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field id="bpm" label="BPM" mixed={mixed("bpm")} {...fieldProps} />
              <Field id="key" label="Key" mixed={mixed("key")} {...fieldProps} />
            </div>
            {error && <p className="font-mono text-[11px] text-destructive">{error}</p>}
          </div>
          <div className="flex justify-end gap-2 border-t p-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!dirty || busy}
              onClick={() => {
                setForm(base.form);
                setTouched(new Set());
                setStagedArt(null);
              }}
            >
              Revert
            </Button>
            <Button type="submit" size="sm" disabled={!dirty || busy} className="bg-brand text-brand-foreground hover:bg-brand-strong">
              {busy ? <Loader2 className="animate-spin" /> : null}
              Save
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
