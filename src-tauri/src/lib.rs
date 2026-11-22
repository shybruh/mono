mod audio;
mod config;
mod integrations;
mod library;
mod lyrics;
mod meta;
mod tags;

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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: &'static str,
    discord_builtin: bool,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo { version: env!("CARGO_PKG_VERSION"), discord_builtin: !integrations::BUILTIN_DISCORD_APP_ID.is_empty() }
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

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

// ------------------------------------------------------------------ entry

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

            let handle = app.handle().clone();
            let cfg_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let config = ConfigStore::load(cfg_dir);
            let cfg = config.get();

            let (tx, rx) = unbounded();
            let (hook_tx, hook_rx) = unbounded();
            let (analysis_tx, analysis_rx) = unbounded();
            let shared = Arc::new(Shared::new(cfg.volume));

            integrations::spawn(data_dir.clone(), hook_rx, cfg.history, cfg.discord, cfg.discord_app_id.clone());

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
            Engine::spawn(handle.clone(), shared, rx, hook_tx, analysis_tx, cfg.rg_mode.clone(), cfg.rg_preamp);
            let _ = tx.send(Cmd::SetRepeat(cfg.repeat));

            let state = app.state::<AppState>();
            *state.watcher.lock() = library::watch(&handle, &cfg.roots);
            library::spawn_indexer(handle, cfg.roots);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the main window quits, even if the deck is open.
            tauri::WindowEvent::CloseRequested { .. } if window.label() == "main" => {
                window.app_handle().exit(0);
            }
            tauri::WindowEvent::Destroyed => {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    state.player.drop_window(window.label());
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            update_config,
            crates,
            tracks,
            history_tracks,
            library_index,
            track_meta,
            waveform,
            cover,
            lyrics,
            store_lyrics,
            app_info,
            save_playlist,
            write_tags,
            set_cover,
            set_cover_data,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running mono");
}
