mod analysis;
mod audio;
mod config;
mod integrations;
mod library;
mod lyrics;
mod media;
mod meta;
mod smart;
mod tags;
mod thumbs;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crossbeam_channel::{unbounded, Sender};
use notify_debouncer_mini::notify::RecommendedWatcher;
use notify_debouncer_mini::Debouncer;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use audio::player::Engine;
use audio::waveform::WaveformCache;
use audio::{Cmd, Player, Repeat, Shared};
use config::{Config, ConfigStore};
use integrations::Hook;
use library::{CrateNode, IndexEntry};
use meta::{MetaCache, TrackMeta};

pub struct AppState {
    pub meta: MetaCache,
    waveforms: WaveformCache,
    config: ConfigStore,
    player: Player,
    hooks: Sender<Hook>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    data_dir: PathBuf,
}

type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ------------------------------------------------------------------ config

#[tauri::command]
fn get_config(state: State<AppState>) -> Config {
    state.config.get()
}

#[tauri::command]
fn update_config(app: AppHandle, state: State<AppState>, patch: serde_json::Value) -> Res<Config> {
    let (before, after) = state.config.update(patch).map_err(err)?;
    if before.rg_mode != after.rg_mode || before.rg_preamp != after.rg_preamp {
        state.player.send(Cmd::SetReplayGain { mode: after.rg_mode.clone(), preamp: after.rg_preamp });
    }
    if before.eq != after.eq || before.crossfeed != after.crossfeed || before.crossfade != after.crossfade {
        state.player.send(Cmd::SetDsp {
            eq: after.eq.clone(),
            crossfeed: after.crossfeed,
            crossfade: after.crossfade as f64,
        });
    }
    if before.resume != after.resume {
        state.player.send(Cmd::SetResume(after.resume));
    }
    if before.repeat != after.repeat {
        state.player.send(Cmd::SetRepeat(after.repeat));
    }
    if before.history != after.history || before.discord != after.discord || before.discord_app_id != after.discord_app_id {
        let _ = state.hooks.send(Hook::Config {
            history: after.history,
            discord: after.discord,
            app_id: after.discord_app_id.clone(),
        });
    }
    if before.roots != after.roots {
        *state.watcher.lock() = library::watch(&app, &after.roots);
        library::spawn_indexer(app.clone(), after.roots.clone());
    }
    let _ = app.emit("config", &after);
    Ok(after)
}

// ------------------------------------------------------------------ library

#[tauri::command]
async fn crates(state: State<'_, AppState>) -> Res<Vec<CrateNode>> {
    let roots = state.config.get().roots;
    tauri::async_runtime::spawn_blocking(move || library::crate_tree(&roots)).await.map_err(err)
}

#[tauri::command]
async fn tracks(app: AppHandle, path: String) -> Res<Vec<TrackMeta>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        library::tracks_in(&state.meta, Path::new(&path))
    })
    .await
    .map_err(err)
}

#[tauri::command]
async fn history_tracks(app: AppHandle, days: u64) -> Res<Vec<TrackMeta>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let paths: Vec<PathBuf> =
            integrations::read_history(&state.data_dir, days).into_iter().map(PathBuf::from).collect();
        library::metas(&state.meta, &paths)
    })
    .await
    .map_err(err)
}

/// Tracks matching a smart crate's rules across all watched folders.
#[tauri::command]
async fn smart_tracks(app: AppHandle, def: smart::SmartDef) -> Res<Vec<TrackMeta>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let files = library::all_files(&state.config.get().roots);
        smart::filter(&def, library::metas(&state.meta, &files))
    })
    .await
    .map_err(err)
}

#[tauri::command]
async fn library_index(app: AppHandle) -> Res<Vec<IndexEntry>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        library::index(&state.meta, &state.config.get().roots)
    })
    .await
    .map_err(err)
}

#[tauri::command]
async fn track_meta(app: AppHandle, path: String) -> Res<TrackMeta> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().meta.get(Path::new(&path)))
        .await
        .map_err(err)
}

#[tauri::command]
async fn waveform(app: AppHandle, path: String, buckets: usize) -> Res<Vec<f32>> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().waveforms.get(Path::new(&path), buckets).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn cover(path: String) -> Res<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || tags::cover(Path::new(&path))).await.map_err(err)
}

#[tauri::command]
async fn lyrics(app: AppHandle, path: String) -> Res<lyrics::Found> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let meta = state.meta.get(Path::new(&path));
        lyrics::find(&meta, &state.data_dir, state.config.get().lyrics_online)
    })
    .await
    .map_err(err)
}

/// Caches (and parses) lyrics the UI fetched from LRCLIB; `raw: null` records a miss.
#[tauri::command]
fn store_lyrics(state: State<AppState>, path: String, raw: Option<String>, pinned: bool) -> Option<lyrics::Lyrics> {
    let meta = state.meta.get(Path::new(&path));
    lyrics::store(&meta, &state.data_dir, raw.as_deref(), pinned)
}

/// Writes lyrics synced in the app as <track>.lrc.
#[tauri::command]
fn save_lrc(state: State<AppState>, path: String, lrc: String) -> Res<Option<lyrics::Lyrics>> {
    let meta = state.meta.get(Path::new(&path));
    lyrics::save_sidecar(&meta, &state.data_dir, &lrc).map_err(err)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    discord_builtin: bool,
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        // tauri.conf.json version, which the release workflow sets from the tag.
        version: app.package_info().version.to_string(),
        discord_builtin: !integrations::BUILTIN_DISCORD_APP_ID.is_empty(),
    }
}

#[derive(serde::Serialize)]
struct Dropped {
    folders: Vec<String>,
    audio: Vec<String>,
}

/// Sorts paths dropped on the window into folders (to add as crates) and
/// playable files; anything else is ignored.
#[tauri::command]
fn sort_dropped(paths: Vec<String>) -> Dropped {
    let mut out = Dropped { folders: Vec::new(), audio: Vec::new() };
    for p in paths {
        let path = Path::new(&p);
        if path.is_dir() {
            out.folders.push(p);
        } else if meta::is_audio(path) {
            out.audio.push(p);
        }
    }
    out
}

#[tauri::command]
fn save_playlist(path: String, tracks: Vec<String>) -> Res<()> {
    library::write_playlist(Path::new(&path), &tracks).map_err(err)
}

// ------------------------------------------------------------------ tags

fn after_tag_write(state: &AppState, path: &str) {
    state.meta.invalidate(path);
    state.player.send(Cmd::RefreshMeta(path.to_owned()));
}

#[tauri::command]
fn write_tags(state: State<AppState>, path: String, tags: tags::TagEdit) -> Res<TrackMeta> {
    tags::write(Path::new(&path), &tags).map_err(err)?;
    after_tag_write(&state, &path);
    Ok(state.meta.get(Path::new(&path)))
}

#[tauri::command]
fn set_cover(state: State<AppState>, path: String, image: String) -> Res<()> {
    tags::set_cover(Path::new(&path), Path::new(&image)).map_err(err)?;
    after_tag_write(&state, &path);
    Ok(())
}

/// Detects BPM and key, writes them into the file's tags and returns the
/// refreshed metadata.
#[tauri::command]
async fn analyse_track(app: AppHandle, path: String) -> Res<TrackMeta> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let p = Path::new(&path);
        let a = analysis::analyse(p).map_err(err)?;
        tags::write_bpm_key(p, a.bpm, a.key.as_deref()).map_err(err)?;
        after_tag_write(&state, &path);
        Ok(state.meta.get(p))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
fn set_cover_data(state: State<AppState>, path: String, data: String, mime: String) -> Res<()> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(err)?;
    tags::set_cover_bytes(Path::new(&path), bytes, &mime).map_err(err)?;
    after_tag_write(&state, &path);
    Ok(())
}

#[tauri::command]
fn remove_cover(state: State<AppState>, path: String) -> Res<()> {
    tags::remove_cover(Path::new(&path)).map_err(err)?;
    after_tag_write(&state, &path);
    Ok(())
}

#[tauri::command]
fn renumber(state: State<AppState>, paths: Vec<String>) -> Res<()> {
    tags::renumber(&paths).map_err(err)?;
    for p in &paths {
        after_tag_write(&state, p);
    }
    Ok(())
}

// ------------------------------------------------------------------ transport

#[tauri::command]
fn play_queue(state: State<AppState>, paths: Vec<String>, index: usize) {
    state.player.send(Cmd::PlayQueue { paths, index });
}
#[tauri::command]
fn set_queue(state: State<AppState>, paths: Vec<String>, index: usize) {
    state.player.send(Cmd::SetQueue { paths, index });
}
#[tauri::command]
fn play_index(state: State<AppState>, index: usize) {
    state.player.send(Cmd::PlayIndex(index));
}
#[tauri::command]
fn toggle(state: State<AppState>) {
    state.player.send(Cmd::Toggle);
}
#[tauri::command]
fn play(state: State<AppState>) {
    state.player.send(Cmd::Play);
}
#[tauri::command]
fn pause(state: State<AppState>) {
    state.player.send(Cmd::Pause);
}
#[tauri::command]
fn next(state: State<AppState>) {
    state.player.send(Cmd::Next);
}
#[tauri::command]
fn prev(state: State<AppState>) {
    state.player.send(Cmd::Prev);
}
#[tauri::command]
fn seek(state: State<AppState>, pos: f64) {
    state.player.send(Cmd::Seek(pos));
}
#[tauri::command]
fn seek_relative(state: State<AppState>, delta: f64) {
    state.player.send(Cmd::SeekRelative(delta));
}
#[tauri::command]
fn set_loop(state: State<AppState>, a: Option<f64>, b: Option<f64>) {
    state.player.send(Cmd::SetLoop { a, b });
}
#[tauri::command]
fn set_speed(state: State<AppState>, speed: f64) {
    state.player.send(Cmd::SetSpeed(speed));
}
#[tauri::command]
fn set_pitch(state: State<AppState>, semitones: f32) {
    state.player.send(Cmd::SetPitch(semitones));
}
#[tauri::command]
fn set_volume(state: State<AppState>, volume: f32) {
    state.player.send(Cmd::SetVolume(volume));
}
#[tauri::command]
fn set_repeat(app: AppHandle, state: State<AppState>, repeat: Repeat) -> Res<()> {
    let (_, after) = state.config.update(serde_json::json!({ "repeat": repeat })).map_err(err)?;
    state.player.send(Cmd::SetRepeat(repeat));
    let _ = app.emit("config", &after);
    Ok(())
}
#[tauri::command]
fn sync_state(state: State<AppState>) {
    state.player.send(Cmd::EmitState);
}
#[tauri::command]
fn set_meters(window: WebviewWindow, state: State<AppState>, on: bool, seq: u64) {
    state.player.set_meters(window.label(), on, seq);
}

// ------------------------------------------------------------------ windows

#[tauri::command]
async fn open_deck(app: AppHandle) -> Res<()> {
    if let Some(w) = app.get_webview_window("deck") {
        w.show().map_err(err)?;
        w.set_focus().map_err(err)?;
    } else {
        WebviewWindowBuilder::new(&app, "deck", WebviewUrl::App("index.html?view=deck".into()))
            .title("mono")
            // The page restores the last size and adjusts width when meters change.
            .inner_size(620.0, 64.0)
            .min_inner_size(280.0, 52.0)
            .max_inner_size(4000.0, 280.0)
            .decorations(false)
            .always_on_top(true)
            .resizable(true)
            // Transparent so the Glass / Frost themes can show the OS blur.
            .transparent(true)
            .shadow(true)
            .build()
            .map_err(err)?;
    }
    if let Some(main) = app.get_webview_window("main") {
        main.hide().map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
async fn close_deck(app: AppHandle) -> Res<()> {
    if let Some(main) = app.get_webview_window("main") {
        main.show().map_err(err)?;
        main.unminimize().map_err(err)?;
        main.set_focus().map_err(err)?;
    }
    if let Some(w) = app.get_webview_window("deck") {
        app.state::<AppState>().player.drop_window("deck");
        w.close().map_err(err)?;
    }
    Ok(())
}

/// Album-art URL for the Discord status (looked up by the UI); None clears it.
#[tauri::command]
fn discord_art(state: State<AppState>, path: String, url: Option<String>) {
    let _ = state.hooks.send(Hook::Art { path, url });
}

/// Lets the audio thread save the session before the process exits.
fn shutdown_and_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.player.send(Cmd::Shutdown);
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    app.exit(0);
}

#[tauri::command]
fn quit(app: AppHandle) {
    shutdown_and_exit(&app);
}

/// Audio files among command-line arguments.
fn audio_args(args: impl Iterator<Item = String>) -> Vec<String> {
    args.filter(|a| {
        let p = Path::new(a);
        p.is_file() && meta::is_audio(p)
    })
    .collect()
}

// ------------------------------------------------------------------ entry

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("cover", |ctx, request, responder| {
            let cache = ctx.app_handle().path().app_cache_dir().map(|d| d.join("thumbs")).unwrap_or_default();
            std::thread::spawn(move || responder.respond(thumbs::serve(&cache, &request)));
        })
        // Must be first: a second launch (e.g. "Open with Mono" while running)
        // hands its files to this instance and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = audio_args(argv.into_iter().skip(1));
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
            if let Some(w) = app.get_webview_window("main") {
                if !w.is_visible().unwrap_or(true) {
                    // Micro-deck mode: keep the deck, just bring it forward.
                    if let Some(deck) = app.get_webview_window("deck") {
                        let _ = deck.set_focus();
                        return;
                    }
                    let _ = w.show();
                }
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

            let handle = app.handle().clone();
            let cfg_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let data_dir_for_engine = data_dir.clone();
            let config = ConfigStore::load(cfg_dir);
            let cfg = config.get();

            let (tx, rx) = unbounded();
            let (hook_tx, hook_rx) = unbounded();
            let (analysis_tx, analysis_rx) = unbounded();
            let shared = Arc::new(Shared::new(cfg.volume));

            // Media keys and the system's now-playing panel. Setup runs on the
            // main thread, which the controls need.
            let media = match (app.get_webview_window("main"), app.path().app_cache_dir()) {
                (Some(main), Ok(cache)) => media::init(&handle, &main, tx.clone(), cache.join("thumbs")),
                _ => None,
            };
            integrations::spawn(
                data_dir.clone(),
                hook_rx,
                cfg.history,
                cfg.discord,
                cfg.discord_app_id.clone(),
                media,
            );

            app.manage(AppState {
                meta: MetaCache::default(),
                waveforms: WaveformCache::default(),
                config,
                player: Player::new(tx.clone(), shared.clone()),
                hooks: hook_tx.clone(),
                watcher: Mutex::new(None),
                data_dir,
            });

            audio::meters::spawn(handle.clone(), shared.clone(), analysis_rx);
            Engine::spawn(
                handle.clone(),
                shared,
                rx,
                hook_tx,
                analysis_tx,
                cfg.rg_mode.clone(),
                cfg.rg_preamp,
                data_dir_for_engine,
                cfg.resume,
            );
            let _ = tx.send(Cmd::SetRepeat(cfg.repeat));
            let _ = tx.send(Cmd::SetDsp {
                eq: cfg.eq.clone(),
                crossfeed: cfg.crossfeed,
                crossfade: cfg.crossfade as f64,
            });

            // Files passed on the command line ("Open with", drag onto the exe)
            // start playing straight away.
            let launch = audio_args(std::env::args().skip(1));
            if !launch.is_empty() {
                let _ = tx.send(Cmd::PlayQueue { paths: launch, index: 0 });
            } else if cfg.resume {
                if let Some(s) = audio::resume::load_session(&app.state::<AppState>().data_dir) {
                    let _ = tx.send(Cmd::Restore { paths: s.queue, index: s.index, pos: s.pos });
                }
            }

            let state = app.state::<AppState>();
            *state.watcher.lock() = library::watch(&handle, &cfg.roots);
            library::spawn_indexer(handle, cfg.roots);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the main window quits, even if the deck is open.
            tauri::WindowEvent::CloseRequested { .. } if window.label() == "main" => {
                shutdown_and_exit(window.app_handle());
            }
            tauri::WindowEvent::Destroyed => {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    state.player.drop_window(window.label());
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            sort_dropped,
            get_config,
            update_config,
            crates,
            tracks,
            history_tracks,
            library_index,
            smart_tracks,
            track_meta,
            waveform,
            cover,
            lyrics,
            store_lyrics,
            save_lrc,
            app_info,
            save_playlist,
            write_tags,
            set_cover,
            set_cover_data,
            analyse_track,
            remove_cover,
            renumber,
            play_queue,
            set_queue,
            play_index,
            toggle,
            play,
            pause,
            next,
            prev,
            seek,
            seek_relative,
            set_loop,
            set_speed,
            set_pitch,
            set_volume,
            set_repeat,
            sync_state,
            set_meters,
            open_deck,
            close_deck,
            quit,
            discord_art,
        ])
        .run(tauri::generate_context!())
        .expect("error while running mono");
}
