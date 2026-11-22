// Stamps a release version (from the git tag) into every manifest and points
// the updater at this repository's GitHub Releases.
//
//   node scripts/prepare-release.mjs 1.2.3
//
// GITHUB_REPOSITORY ("owner/name") is provided by GitHub Actions.

import { readFileSync, writeFileSync } from "node:fs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Not a semver version: "${process.argv[2] ?? ""}"`);
  process.exit(1);
}
const repo = process.env.GITHUB_REPOSITORY;

const confPath = "src-tauri/tauri.conf.json";
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = version;
if (repo) {
  conf.plugins.updater.endpoints = [`https://github.com/${repo}/releases/latest/download/latest.json`];
}
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const cargoPath = "src-tauri/Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8").replace(
  /(\[package\][^[]*?\nversion\s*=\s*")[^"]*(")/,
  `$1${version}$2`,
);
writeFileSync(cargoPath, cargo);

console.log(`version ${version}${repo ? `, updates from ${repo}` : ""}`);
