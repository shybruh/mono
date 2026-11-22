import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import type { SmartCrate, SmartRule } from "@/lib/api";
import { EMPTY, useStore } from "@/lib/store";
import { keyToTag, parseKey } from "@/lib/keys";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type Kind = "text" | "number" | "added";

export const SMART_FIELDS: { id: string; label: string; kind: Kind; unit?: string }[] = [
  { id: "title", label: "Title", kind: "text" },
  { id: "artist", label: "Artist", kind: "text" },
  { id: "album", label: "Album", kind: "text" },
  { id: "albumArtist", label: "Album artist", kind: "text" },
  { id: "genre", label: "Genre", kind: "text" },
  { id: "key", label: "Key", kind: "text" },
  { id: "format", label: "Format", kind: "text" },
  { id: "folder", label: "Folder", kind: "text" },
  { id: "year", label: "Year", kind: "number" },
  { id: "bpm", label: "BPM", kind: "number" },
  { id: "bitrate", label: "Bitrate", kind: "number", unit: "kbps" },
  { id: "duration", label: "Length", kind: "number", unit: "min" },
  { id: "added", label: "Added", kind: "added" },
];

const OPS: Record<Kind, { id: string; label: string }[]> = {
  text: [
    { id: "contains", label: "contains" },
    { id: "is", label: "is" },
    { id: "isNot", label: "is not" },
    { id: "startsWith", label: "starts with" },
  ],
  number: [
    { id: "is", label: "is" },
    { id: "gt", label: "more than" },
    { id: "lt", label: "less than" },
    { id: "between", label: "between" },
  ],
  added: [{ id: "within", label: "in the last" }],
};

const kindOf = (field: string): Kind => SMART_FIELDS.find((f) => f.id === field)?.kind ?? "text";
const newRule = (): SmartRule => ({ field: "genre", op: "contains", value: "" });


export function SmartCrateDialog() {
  const editing = useStore((s) => s.smartEdit);
  const crates = useStore((s) => s.config?.smartCrates ?? EMPTY);
  const [draft, setDraft] = useState<SmartCrate | null>(null);

  useEffect(() => setDraft(editing ? structuredClone(editing) : null), [editing]);
  if (!draft) return null;

  const close = () => useStore.getState().setSmartEdit(null);
  const setRule = (i: number, patch: Partial<SmartRule>) =>
    setDraft({ ...draft, rules: draft.rules.map((r, k) => (k === i ? { ...r, ...patch } : r)) });

  const save = async () => {
    // Keys are stored in canonical form so "8A" matches a tag of "Am".
    const rules = draft.rules
      .filter((r) => r.value.trim())
      .map((r) => {
        if (r.field !== "key") return r;
        const k = parseKey(r.value);
        return k ? { ...r, value: keyToTag(k) } : r;
      });
    const crate = { ...draft, name: draft.name.trim() || "Smart crate", rules };
    const exists = crates.some((c) => c.id === crate.id);
    const next = exists ? crates.map((c) => (c.id === crate.id ? crate : c)) : [...crates, crate];
    const s = useStore.getState();
    await s.setConfig({ smartCrates: next });
    close();
    await s.openView({ kind: "smart", id: crate.id, name: crate.name });
  };

  return (
    <Dialog open onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">Smart crate</DialogTitle>
          <DialogDescription className="sr-only">Rules that pick tracks from your library</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            autoFocus
            placeholder="Name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="h-9"
          />
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            Match
            <Select value={draft.matchAll ? "all" : "any"} onValueChange={(v) => setDraft({ ...draft, matchAll: v === "all" })}>
              <SelectTrigger size="sm" className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">all</SelectItem>
                <SelectItem value="any">any</SelectItem>
              </SelectContent>
            </Select>
            of these rules
          </div>
          <div className="space-y-2">
            {draft.rules.map((r, i) => {
              const kind = kindOf(r.field);
              const field = SMART_FIELDS.find((f) => f.id === r.field);
              return (
                <div key={i} className="flex items-center gap-2">
                  <Select
                    value={r.field}
                    onValueChange={(v) => {
                      const k = kindOf(v);
                      setRule(i, { field: v, op: kind === k ? r.op : OPS[k][0].id, value: "", value2: null });
                    }}
                  >
                    <SelectTrigger size="sm" className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SMART_FIELDS.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={r.op} onValueChange={(v) => setRule(i, { op: v })}>
                    <SelectTrigger size="sm" className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OPS[kind].map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={r.value}
                    onChange={(e) => setRule(i, { value: e.target.value })}
                    placeholder={kind === "text" ? (r.field === "key" ? "Am or 8A" : "text") : "0"}
                    inputMode={kind === "text" ? undefined : "decimal"}
                    className="h-8 min-w-0 flex-1 font-mono text-[12px]"
                  />
                  {r.op === "between" && (
                    <>
                      <span className="text-[12px] text-muted-foreground">and</span>
                      <Input
                        value={r.value2 ?? ""}
                        onChange={(e) => setRule(i, { value2: e.target.value })}
                        inputMode="decimal"
                        className="h-8 w-20 font-mono text-[12px]"
                      />
                    </>
                  )}
                  {(field?.unit || kind === "added") && (
                    <span className="w-9 text-[12px] text-muted-foreground">{kind === "added" ? "days" : field?.unit}</span>
                  )}
                  <button
                    aria-label="Remove rule"
                    onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, k) => k !== i) })}
                    className="rounded p-1 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              );
            })}
            <button
              onClick={() => setDraft({ ...draft, rules: [...draft.rules, newRule()] })}
              className="flex items-center gap-1.5 rounded-md px-1 py-1 text-[12px] text-muted-foreground hover:text-foreground"
            >
              <Plus className="size-3.5" /> Add rule
            </button>
          </div>
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            Limit to
            <Input
              value={draft.limit ?? ""}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setDraft({ ...draft, limit: Number.isFinite(n) && n > 0 ? n : null });
              }}
              placeholder="all"
              inputMode="numeric"
              className="h-8 w-20 font-mono text-[12px]"
            />
            newest tracks
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} className="bg-brand text-brand-foreground hover:bg-brand-strong">
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
