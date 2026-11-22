// Prints the CHANGELOG.md section for a version, for use as release notes.
// Falls back to the [Unreleased] section, then to nothing.
//
//   node scripts/release-notes.mjs 1.2.3

import { readFileSync } from "node:fs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
const text = readFileSync("CHANGELOG.md", "utf8");

function section(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, "m"));
  return m ? m[1].trim() : "";
}

process.stdout.write(section(version) || section("Unreleased") || "");
