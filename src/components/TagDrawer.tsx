import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ImageUp, Trash2 } from "lucide-react";
import { api, type TagEdit, type TrackMeta } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { basename } from "@/lib/utils";

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

  const load = async (p: string) => {
    const m = await api.trackMeta(p);
    setMeta(m);
    setForm(fromMeta(m));
    setCover(await api.cover(p));
    setError(null);
  };

  useEffect(() => {
    if (path) load(path);
  }, [path]);

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

  const dirty = meta != null && JSON.stringify(fromMeta(meta)) !== JSON.stringify(form);

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
            if (path) run(() => api.writeTags(path, toEdit(form)));
          }}
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <div className="flex items-end gap-3">
              <div className="size-28 shrink-0 overflow-hidden rounded-lg bg-brand-wash">
                {cover && <img src={cover} alt="" className="size-full object-cover" draggable={false} />}
              </div>
              <div className="flex flex-col gap-2">
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
