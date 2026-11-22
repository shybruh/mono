# Changelog

All notable changes to Mono are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-22

First working build.

### Added

#### Audio engine (Rust)
- Decoding via Symphonia for MP3, FLAC, WAV, Ogg Vorbis and AAC/M4A, with each file read fully into memory before playback.
- Lock-free output path: decode thread → ring buffer (~200 ms) → cpal device callback, with a ~4 ms gain ramp so pause and volume changes never click.
- **Gapless playback**: the next queue entry is loaded and its decoder opened ~6 s before the current track ends; at end-of-stream the pipeline switches source without flushing. LAME/iTunes encoder delay and padding are trimmed.
- Sample-accurate position reporting derived from frames the device has consumed, so the clock stays correct across gapless transitions and tempo changes.
- **ReplayGain**: reads `REPLAYGAIN_TRACK_*` / `REPLAYGAIN_ALBUM_*` tags; track, album or off, with pre-amp and peak-based clip protection.
- **A–B loop**: seamless, sample-accurate wrap handled in the decoder (no buffer flush at the loop point).
- **Independent tempo and pitch** (0.5×–2×, ±12 semitones) via a vendored build of Signalsmith Stretch.
- Automatic resampling to the device rate (rubato FFT resampler).
- Output stream recovers automatically when the audio device changes or disappears.

#### Library
- **Directory-native crates**: watched folders, their sub-folders and `.m3u` / `.m3u8` files appear as crates. Nothing is imported or copied.
- File-system watcher keeps crates and the open track list current.
- Background metadata indexer feeding the command palette.
- Save any crate as an `.m3u8` playlist (relative paths).
- Listening history (JSON Lines in the app data folder) with *Last 7 days* / *Last 30 days* views.

#### Interface
- Main window: crate sidebar, now-playing header with cover art and a live spec readout (bitrate, sample rate, bit depth, channels, format, applied ReplayGain), track list with per-track gain column.
- UI accent derived from the current cover art (OKLCH), with a toggle to keep the default.
- **Seek bar with pop-out waveform**: a thin bar at rest; on hover a pre-rendered amplitude waveform rises from the cursor, lingers ~0.7 s after the pointer leaves, and supports click and drag scrubbing. Loop regions are drawn on both.
- **Command palette** (`Ctrl+K` or `/`): fuzzy search across tracks, crates and commands.
- **Tag drawer**: edit title, artist, album, album artist, genre, year, track / total and disc; replace or remove embedded cover art; renumber a crate in its current order.
- **Visualiser panel**: log-frequency spectrum, triggered oscilloscope, stereo peak meters with hold, and BS.1770 momentary / short-term LUFS. Analysis runs only while a meter is on screen.
- **Micro-deck**: frameless always-on-top strip with transport, progress line, spectrum, scope, peak and LUFS meters. Skins: Zinc, Cover, Phosphor, Amber. Meters and skin can be changed from its right-click menu.
- **Discord Rich Presence** (optional, off by default): shows the current track as a *Listening* activity using your own Discord application ID.
- Settings: watched folders, ReplayGain mode and pre-amp, cover accent, deck skin, history and Discord modules.
- Keyboard: `Space` play/pause, `←/→` seek ±5 s (`Shift` ±30 s), `↑/↓` + `Enter` browse and play, `[` / `]` / `\` loop A / B / clear, `0` reset tempo and pitch, `N` / `P` next / previous, `R` repeat, `V` visualiser, `M` micro-deck, `T` tags, `Ctrl+,` settings.
