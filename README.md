# mono

A lightweight, directory-native audio player for Windows, macOS and Linux.
Rust audio engine, Tauri 2 shell, React + shadcn/ui interface.

- Gapless playback with pre-buffered next track
- Pop-out waveform seek bar
- ReplayGain (track / album, pre-amp, clip protection)
- A–B loop and independent tempo / pitch
- Live spec readout: bitrate, sample rate, bit depth, channels, format
- Folders and `.m3u8` files as crates — no library import
- Command palette (`Ctrl+K` or `/`)
- Inline tag and cover-art editing
- Always-on-top micro-deck with skins
- Spectrum, scope, peak and LUFS visualiser
- Optional listening history and Discord Rich Presence

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

## Discord Rich Presence

Turn on **Settings → Modules → Discord Rich Presence**. Mono ships with its own Discord application, so your status reads *Listening to mono* with no setup.

To show a different name, create your own application in the [Discord Developer Portal](https://discord.com/developers/applications) and paste its Application ID into the override field. Upload an art asset with the key `mono` to get the logo next to the activity.

## Keyboard

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` `→` | Seek ±5 s (`Shift` for ±30 s) |
| `↑` `↓` `Enter` | Move selection, play |
| `[` `]` `\` | Set loop A, set loop B, clear loop |
| `0` | Reset tempo and pitch |
| `N` `P` | Next, previous |
| `R` | Cycle repeat |
| `V` | Visualiser |
| `M` | Micro-deck |
| `F` | Theater mode and lyrics |
| `F11` | Fullscreen (`Esc` to leave) |
| `T` | Tag drawer |
| `Ctrl+K` `/` | Command palette |
| `Ctrl+,` | Settings |

## Layout

```
src/                 React interface
  components/        Title bar, sidebar, track list, transport, seek bar,
                     palette, tag drawer, settings, visualiser, micro-deck
  lib/               Tauri API bindings, store, accent extraction, fuzzy search
src-tauri/
  src/audio/         Decoder, output stream, player engine, resampler,
                     time-stretch bindings, waveform, meters
  src/library.rs     Crates, playlists, watcher, indexer
  src/meta.rs        Tag + telemetry reading, ReplayGain
  src/tags.rs        Tag and cover-art writing
  src/integrations.rs History and Discord Rich Presence
  vendor/            Signalsmith Stretch (MIT) + C ABI shim
```

## Licences

Bundled third-party code: [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) and Signalsmith Linear (MIT) — see `src-tauri/vendor/signalsmith/*/LICENSE.txt`.
