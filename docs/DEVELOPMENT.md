# Development

## Building

Requirements:

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 20+ and [pnpm](https://pnpm.io)
- A C++ compiler (MSVC Build Tools on Windows, Xcode CLT on macOS, `g++` on Linux) for the bundled time-stretch library
- The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform

```sh
pnpm install
pnpm tauri dev      # run in development
pnpm tauri build    # produce an installer in src-tauri/target/release/bundle
```

`pnpm tauri build` also produces signed updater bundles, so it needs the updater key (see below):

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $HOME\.tauri\mono-updater.key; pnpm tauri build
```

`pnpm tauri build --no-bundle` builds just the executable.

## Benchmarks

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bench.ps1 -File C:\path\to\song.mp3 -Mono src-tauri\target\release\mono.exe
```

Measures launch time (median of 5), private memory and CPU (summed over every process an app starts) idle and while playing, and size on disk, for Mono and any of AIMP, VLC and Spotify that are installed. `-Only Mono` runs a subset. Results are written as JSON; the README table comes from [`bench-results.json`](bench-results.json).

## Releasing

Releases are built by GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) and delivered to installed copies by the built-in updater.

1. Move the `[Unreleased]` notes in `CHANGELOG.md` under a new `## [x.y.z] - date` heading. That section becomes the release notes.
2. Tag and push:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

The workflow stamps the version from the tag into `tauri.conf.json`, `package.json` and `Cargo.toml`, builds Windows (NSIS + MSI), macOS (Apple Silicon and Intel) and Linux (AppImage, deb, rpm), signs the update bundles, uploads everything with a `latest.json` manifest to a draft release, and publishes it once all platforms succeed. Running copies of Mono pick it up within a few hours (or via **Settings → Updates → Check now**). Tags with a suffix such as `v1.0.0-beta.1` are published as pre-releases, which the updater ignores.

### One-time setup

Updates are signed so installed copies only accept builds made with your key. Add the repository secret under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the contents of your updater private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | only if the key has a password; skip it otherwise (GitHub doesn't allow empty secrets) |

The matching public key is in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. Keep a backup of the private key: without it, existing installs can't verify future updates. A new pair can be made with `pnpm tauri signer generate -w ~/.tauri/mono-updater.key`, after which the public key in `tauri.conf.json` must be replaced.

The builds are not code-signed with an OS certificate, so Windows SmartScreen and macOS Gatekeeper warn on first install.

## Discord application

Mono ships with its own Discord application ID (`BUILTIN_DISCORD_APP_ID` in `src-tauri/src/integrations.rs`). It is a public client ID, not a secret. Users can override it in Settings; uploading an art asset with the key `mono` in the Discord Developer Portal shows the logo next to the activity.

## Layout

```
src/                  React interface
  components/         Title bar, sidebar, track list, transport, seek bar,
                      palette, tag drawer, settings, visualiser, theater, micro-deck
  lib/                Tauri API bindings, store, themes, lyrics, metadata lookup
src-tauri/
  src/audio/          Decoder, output stream, player engine, resampler,
                      time-stretch bindings, waveform, meters
  src/library.rs      Crates, playlists, watcher, indexer
  src/meta.rs         Tag + telemetry reading, file-name fallback, ReplayGain
  src/tags.rs         Tag and cover-art writing
  src/lyrics.rs       .lrc / embedded lyrics, cache
  src/integrations.rs History and Discord Rich Presence
  vendor/             Signalsmith Stretch (MIT) + C ABI shim
scripts/              Release helpers, benchmark
```
