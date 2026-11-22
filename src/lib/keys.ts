// Musical key parsing and display: standard ("Am", "F#", "Eb") or Camelot
// ("8A", "2B"). Accepts what other apps write: "A minor", "Amin", "8A", "C#m".

export type KeyNotation = "musical" | "camelot";

const MAJOR = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];
// Camelot wheel numbers by pitch class (C = 0).
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

const NOTE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export interface Key {
  pc: number;
  minor: boolean;
}

export function parseKey(raw: string | null | undefined): Key | null {
  if (!raw) return null;
  const s = raw.trim();
  const camelot = /^(\d{1,2})\s*([ABab])$/.exec(s);
  if (camelot) {
    const n = Number(camelot[1]);
    const minor = camelot[2].toUpperCase() === "A";
    const pc = (minor ? CAMELOT_MINOR : CAMELOT_MAJOR).indexOf(n);
    return pc >= 0 ? { pc, minor } : null;
  }
  const m = /^([A-Ga-g])\s*([#♯b♭]?)\s*(.*)$/.exec(s);
  if (!m) return null;
  let pc = NOTE[m[1].toUpperCase()];
  if (m[2] === "#" || m[2] === "♯") pc += 1;
  if (m[2] === "b" || m[2] === "♭") pc -= 1;
  const rest = m[3].toLowerCase();
  const minor = rest === "m" || rest.startsWith("min") || rest === "-";
  return { pc: (pc + 12) % 12, minor };
}

/** Storage form written to tags. */
export const keyToTag = (k: Key) => (k.minor ? MINOR : MAJOR)[k.pc];

export function formatKey(raw: string | null | undefined, notation: KeyNotation): string {
  const k = parseKey(raw);
  if (!k) return raw ?? "";
  if (notation === "camelot") return `${(k.minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[k.pc]}${k.minor ? "A" : "B"}`;
  return keyToTag(k);
}

/** Sorts around the Camelot wheel so harmonically close keys sit together. */
export function keySortValue(raw: string | null | undefined): number | null {
  const k = parseKey(raw);
  if (!k) return null;
  return (k.minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[k.pc] * 2 + (k.minor ? 0 : 1);
}
