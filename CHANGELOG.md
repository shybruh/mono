# Changelog

All notable changes to Mono are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-11-22

Mono is now about as light on your processor as the classic native players, and the project has a proper front page.

### Performance
- **Up to 90× less CPU when idle and 7× less while playing.** On a Ryzen 7 5700X3D, idle CPU dropped from 1.8 % to 0.02 % and playback from 2.1 % to 0.28 %, level with AIMP (0.23 %) and VLC (0.24 %). Memory while playing fell from 211 MB to 141 MB.
- The waveform, seek bar, spectrum, scope and peak meters now redraw only when something on screen changes, instead of 60 times a second.
- The meter analysis goes quiet once the meters have fallen to silence.
- The seek bar repaints only when the playhead moves a whole pixel; the micro-deck, lyrics and fullscreen seek line update in coarser steps, and the player sends its position 20 times a second instead of 30.
- The audio thread wakes less often while paused or when its buffer is full.
- The animated "now playing" bars no longer force a page re-layout on every frame.

### Added
- **Open with Mono**: audio files passed to Mono (from *Open with*, dragging onto the app, or the command line) start playing straight away.
- **Benchmark script** (`scripts/bench.ps1`): compares launch time, memory, CPU and size on disk against AIMP, VLC and Spotify if they're installed. Results for this release are in `docs/bench-results.json`.

### Fixed
- Mono kept reopening a folder at launch after it had been removed from the watched folders. It now opens the first watched folder instead.

### Documentation
- New README for listeners: what Mono does, screenshots, a benchmark comparison and keyboard shortcuts. Build, release and project notes moved to `docs/DEVELOPMENT.md`.

## [0.2.0] - 2026-11-22

### Changed
- The waveform is now the seek bar itself: an always-visible, symmetrical amplitude envelope (48 px) replaces the thin bar and hover pop-out. Click or drag anywhere on it to scrub; hovering previews the jump and shows the target time. On track change the bars morph from the previous envelope to the new one in a left-to-right sweep.
- **App-wide themes** replace the deck-only skins: Zinc, Paper (light), Phosphor, Amber and Custom. Every UI colour is derived from three base colours (background, text, accent), so a theme applies consistently to the main window, dialogs, meters and the micro-deck. Theme changes and cover-accent changes cross-fade.
- **Custom theme**: pick background, text and accent colours with a colour picker or hex input; changes preview live. Choosing Custom the first time starts from the theme currently shown.
- Cover-art accent now works on light themes (darker accent) and is skipped for near-greyscale covers and for the Phosphor and Amber themes.
- Text on accent-coloured controls picks black or white for contrast automatically.
- **Micro-deck sizes itself** to its content: it shrinks when meters are turned off and grows when they are turned on. The title column is fixed-width so the deck doesn't jump between tracks, and the time readout no longer gets truncated by long artist names. The deck's right-click menu now offers *Theme* instead of *Skin*.

- Settings dialog is wider (672 px), with a fixed header and its own scroll area.
- Scrollbars are thin floating pills that brighten on hover and take the accent colour while dragged.
- Transport controls are centred under the waveform in a symmetric cluster (A / B · previous / play / next · tempo / repeat), with volume pinned right.
- Discord Rich Presence uses Mono's built-in Discord application, so users only flip the switch; the Settings field is now an optional override. The activity shows the `mono` art asset when the Discord app has one uploaded.

### Added
- **Automatic updates**: Mono checks GitHub Releases for a signed update shortly after launch and every six hours. When one is available a small version button appears in the title bar; clicking it downloads (with progress), installs and restarts. **Settings → Updates** shows the current version, a *Check now* button and a switch to turn automatic checks off. Updates are verified against the public key built into the app.
- **GitHub Actions**: `release.yml` builds Windows, macOS (Apple Silicon and Intel) and Linux installers from a `v*` tag, signs the update bundles, attaches them with an updater manifest to a release whose notes come from this changelog, and publishes it once every platform succeeds. `ci.yml` type-checks, builds the frontend and runs the Rust tests on Windows and Linux for every push to `main` and every pull request.
- **File-name fallback for untagged files**: when a file has no title or artist tag, Mono reads them from the file name (`Artist - Title`, `01 - Artist - Title`, `03. Title`, `07 Title`; en/em dashes and underscores handled; titles like `7 Rings` left intact). This also lets lyrics lookups work for untagged files. Saving in the tag drawer writes the guessed values as real tags.
- **Online metadata and cover art (iTunes Search API)**, all optional:
  - *Look up missing album and cover art* (Settings → Modules, off by default): for the playing track, shows iTunes artwork and fills album / year / genre on screen when the file lacks them. The accent colour follows the fetched art. Files are not modified.
  - Tag drawer **Look up**: lists iTunes matches with artwork, album, year, duration and a confidence dot; picking one fills the form and stages the 1200 px cover, and **Save** writes both into the file.
  - **Fill missing info online** (track list right-click): for every track in the crate missing album, cover or real tags, writes a confident match, filling only empty fields and embedding artwork where there is none. Paced at one lookup every ~3 s for iTunes' rate limit; progress shows in the list header and clicking it stops the run.
- **Glass and Frost themes** (dark and light): the window becomes translucent over the operating system's material (Mica on Windows 11, Acrylic on Windows 10, vibrancy on macOS), in both the main window and the micro-deck. Menus, dialogs, drawers and popovers get their own backdrop blur and a denser fill so text stays legible; a hairline edge keeps the window outline visible. Custom themes gain a *Translucent* switch to frost any colour scheme. Both windows are now created transparent so the effect can be switched on without a restart; Linux has no OS blur and shows the translucent tint only.
- **Fullscreen** (`F11`, the button in theater mode's top-right corner, or the command palette; `Esc` to leave): theater mode across the whole screen with only the cover art, title, lyrics and a thin seek line with elapsed / total time at the bottom (click to seek). The pointer hides after 2.5 s without movement. Play / pause, seek and other shortcuts keep working.
- **Lyric versions picker** (theater mode, top-right on hover; needs LRCLIB enabled): lists every LRCLIB version of the song with artist, album, length (highlighted when it matches the file) and timed / plain. Picking one pins it for that track, overriding embedded, `.lrc` and cached lyrics.
- **Lyric timing nudge** (theater mode): shift synced lyrics earlier or later in 0.25 s steps; click the readout to reset. Remembered per track.
- **Resizable layout**, remembered between launches; double-click any handle to reset:
  - Sidebar: drag its right edge (160–480 px).
  - Track list: every column (#, Title, Artist, Album, Gain, Time) has its own width, set by dragging its boundary in the header, which shows faint dividers. Time stays pinned to the right edge with spare space just before it; the list never scrolls sideways — drags are limited to the free room, and Title / Artist / Album shrink toward their minimums when the window narrows. Header and rows stay aligned regardless of the scrollbar.
  - Visualiser panel: drag its top edge (90 px up to 65% of the window height).
- **Resizable micro-deck**: drag any edge (up to 280 px tall). Cover art, buttons, text and meters scale with the window height, and the spectrum, scope and title share extra width. The size is remembered; toggling a meter still grows or shrinks the window by that meter's width.
- **Seek control setting** (Settings → Seek): choose the waveform or a plain thin bar. Both support click and drag scrubbing, hover preview, the time tooltip and the A–B loop band; the bar skips waveform decoding entirely.
- **Theater mode** (`F`, the microphone button, or click the cover art; `Esc` to leave): large cover art over a blurred, tinted backdrop of the same art, with title, artist and album.
- **Lyrics** in theater mode. Sources, in order: a sidecar `.lrc` next to the file, lyrics embedded in the tags, then [LRCLIB](https://lrclib.net) when *Download lyrics from LRCLIB* is enabled (off by default). Synced lyrics highlight the current line, auto-centre it (pausing for a few seconds after you scroll), and seek when a line is clicked; plain lyrics show as scrollable text. LRCLIB results and misses are cached in the app data folder so each track is looked up once; nothing is written into the music library.

### Fixed
- Release workflow: the draft release's id was read back from a listing that could miss a just-created draft, so builds ran without a release to upload to and the publish step failed with 404. The release is now created (or an existing draft for the tag reused) in a single API call that returns its id, and the job fails immediately if no id is available.
- Synced lyrics could come from a different cut of a song (e.g. the original instead of a remix), so the words were right but the timing ran early or late. Timed lyrics from LRCLIB are now only used automatically when that version's length is within 2 s of the file; otherwise the words are shown untimed. Lyrics cached under the old rules are looked up again.
- Visualiser could stay blank (all readouts at −∞) while audio played. Meter on/off requests from the UI could arrive at the engine out of order, leaving analysis switched off. Requests are now coalesced and sequence-numbered per window, stale ones are ignored, the UI re-asserts its state every few seconds, and closed windows release their claim automatically.
- Micro-deck right-click menu was clipped by the 64 px window; it is now a native menu (Skin and Meters submenus, Back to main window) that can extend past the deck.

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
