import type { SmartCrate } from "./api";

export function newSmartCrate(): SmartCrate {
  return { id: crypto.randomUUID(), name: "", matchAll: true, limit: null, rules: [{ field: "genre", op: "contains", value: "" }] };
}
