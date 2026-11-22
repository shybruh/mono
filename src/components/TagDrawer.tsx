import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ImageUp, Loader2, Search, Trash2 } from "lucide-react";
import { fetchArtwork, search, type Match } from "@/lib/itunes";
import { basename, cn, fmtTime } from "@/lib/utils";
import { api, type TagEdit, type TrackMeta } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type Form = Record<keyof TagEdit, string>;

const empty: Form = {
  title: "",
  artist: "",
  album: "",
  albumArtist: "",
  genre: "",
  year: "",
  track: "",
  trackTotal: "",
  disc: "",
};

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
  };
}

function toEdit(f: Form): TagEdit {
  const n = (v: string) => (v.trim() && Number.isFinite(+v) ? Math.trunc(+v) : null);
  return {
    title: f.title,
    artist: f.artist,
    album: f.album,
    albumArtist: f.albumArtist,
    genre: f.genre,
    year: n(f.year),
    track: n(f.track),
    trackTotal: n(f.trackTotal),
    disc: n(f.disc),
  };
}

function Field({
  id,
  label,
  form,
  set,
  className,
}: {
  id: keyof Form;
  label: string;
  form: Form;
  set: (f: Form) => void;
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
        onChange={(e) => set({ ...form, [id]: e.target.value })}
        className="h-8 font-mono text-[12px]"
        inputMode={["year", "track", "trackTotal", "disc"].includes(id) ? "numeric" : undefined}
      />
    </div>
  );
}

export function TagDrawer() {
  const path = useStore((s) => s.tagTarget);
  const [meta, setMeta] = useState<TrackMeta | null>(null);
  const [form, setForm] = useState<Form>(empty);
  const [cover, setCover] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [looking, setLooking] = useState(false);
  const [stagedArt, setStagedArt] = useState<string | null>(null);

  const load = async (p: string) => {
    const m = await api.trackMeta(p);
    setMeta(m);
    setForm(fromMeta(m));
    setCover(await api.cover(p));
    setError(null);
  };

  useEffect(() => {
    setMatches(null);
    setStagedArt(null);
    if (path) load(path);
  }, [path]);

  const lookUp = async () => {
    setLooking(true);
    setError(null);
    try {
      const list = await search(form.artist, form.title, meta?.duration ?? 0);
      setMatches(list.slice(0, 8));
    } catch {
      setError("iTunes lookup failed");
    } finally {
      setLooking(false);
    }
  };

  const apply = (m: Match) => {
    const s = (v: unknown) => (v == null ? "" : String(v));
    setForm({
      title: m.title || form.title,
      artist: m.artist || form.artist,
      album: m.album || form.album,
      albumArtist: m.albumArtist || form.albumArtist,
      genre: m.genre || form.genre,
      year: s(m.year) || form.year,
      track: s(m.track) || form.track,
      trackTotal: s(m.trackTotal) || form.trackTotal,
      disc: s(m.disc) || form.disc,
    });
    if (m.artwork) setStagedArt(m.artwork);
    setMatches(null);
  };

  const after = async () => {
    if (!path) return;
    await load(path);
    useStore.getState().reloadList();
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await after();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const dirty =
    meta != null && (JSON.stringify(fromMeta(meta)) !== JSON.stringify(form) || meta.inferred || stagedArt != null);

  return (
    <Sheet open={path != null} onOpenChange={(v) => !v && useStore.getState().openTags(null)}>
      <SheetContent className="w-[380px] gap-0 sm:max-w-[380px]">
        <SheetHeader className="border-b">
          <SheetTitle className="text-sm font-medium">Tags</SheetTitle>
          <SheetDescription className="truncate font-mono text-[11px]">{path ? basename(path) : ""}</SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (!path) return;
            run(async () => {
              await api.writeTags(path, toEdit(form));
              if (stagedArt) {
                const art = await fetchArtwork(stagedArt);
                await api.setCoverData(path, art.data, art.mime);
                setStagedArt(null);
              }
            });
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
                <Button type="button" variant="outline" size="sm" disabled={busy || looking} onClick={lookUp}>
                  {looking ? <Loader2 className="animate-spin" /> : <Search />} Look up
                </Button>
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
                    if (typeof img === "string" && path) run(() => api.setCover(path, img));
                  }}
                >
                  <ImageUp /> Replace
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || !meta?.hasCover}
                  onClick={() => path && run(() => api.removeCover(path))}
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
            <Field id="title" label="Title" form={form} set={setForm} />
            <Field id="artist" label="Artist" form={form} set={setForm} />
            <Field id="album" label="Album" form={form} set={setForm} />
            <Field id="albumArtist" label="Album artist" form={form} set={setForm} />
            <div className="grid grid-cols-2 gap-3">
              <Field id="genre" label="Genre" form={form} set={setForm} />
              <Field id="year" label="Year" form={form} set={setForm} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field id="track" label="Track" form={form} set={setForm} />
              <Field id="trackTotal" label="Of" form={form} set={setForm} />
              <Field id="disc" label="Disc" form={form} set={setForm} />
            </div>
            {error && <p className="font-mono text-[11px] text-destructive">{error}</p>}
          </div>
          <div className="flex justify-end gap-2 border-t p-4">
            <Button type="button" variant="ghost" size="sm" disabled={!dirty || busy} onClick={() => meta && setForm(fromMeta(meta))}>
              Revert
            </Button>
            <Button type="submit" size="sm" disabled={!dirty || busy} className="bg-brand text-brand-foreground hover:bg-brand-strong">
              Save
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
