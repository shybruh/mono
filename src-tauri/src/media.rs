//! System media controls: media keys and headset buttons, the Windows media
//! flyout (SMTC), macOS Now Playing and Linux MPRIS, via souvlaki.
//!
//! The controls live on the main thread (macOS requires it, and on Windows
//! they belong to the main window); updates are posted there from the
//! integrations thread, which already follows every track and play/pause.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crossbeam_channel::Sender;
use parking_lot::Mutex;
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig, SeekDirection,
};
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::audio::Cmd;
use crate::meta::TrackMeta;
use crate::thumbs;

/// Only ever touched on the main thread (see `Media::on_main`).
struct Controls(MediaControls);
unsafe impl Send for Controls {}

struct MediaState(Mutex<Option<Controls>>);

/// Handle the integrations thread uses to update the controls.
#[derive(Clone)]
pub struct Media {
    app: AppHandle,
    covers: PathBuf,
}

/// Seconds skipped by a plain "seek forward / back" button.
const SKIP: f64 = 10.0;
/// Cover size handed to the system; the flyouts show it at up to ~300 px.
const COVER: u32 = 512;

/// Registers the controls for the main window. Must run on the main thread
/// (Tauri's `setup` does). Returns `None` where the system has no media
/// controls to offer (e.g. no D-Bus session on Linux).
pub fn init(app: &AppHandle, window: &WebviewWindow, player: Sender<Cmd>, covers: PathBuf) -> Option<Media> {
    #[cfg(target_os = "windows")]
    let hwnd = Some(window.hwnd().ok()?.0 as *mut std::ffi::c_void);
    #[cfg(not(target_os = "windows"))]
    let hwnd = {
        let _ = window;
        None
    };

    let config = PlatformConfig { display_name: "mono", dbus_name: "mono", hwnd };
    let mut controls = MediaControls::new(config).ok()?;

    let handle = app.clone();
    controls
        .attach(move |event| {
            let cmd = match event {
                MediaControlEvent::Play => Cmd::Play,
                MediaControlEvent::Pause | MediaControlEvent::Stop => Cmd::Pause,
                MediaControlEvent::Toggle => Cmd::Toggle,
                MediaControlEvent::Next => Cmd::Next,
                MediaControlEvent::Previous => Cmd::Prev,
                MediaControlEvent::Seek(dir) => Cmd::SeekRelative(signed(dir, SKIP)),
                MediaControlEvent::SeekBy(dir, by) => Cmd::SeekRelative(signed(dir, by.as_secs_f64())),
                MediaControlEvent::SetPosition(MediaPosition(at)) => Cmd::Seek(at.as_secs_f64()),
                MediaControlEvent::Raise => {
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                    return;
                }
                _ => return,
            };
            let _ = player.send(cmd);
        })
        .ok()?;

    app.manage(MediaState(Mutex::new(Some(Controls(controls)))));
    Some(Media { app: app.clone(), covers })
}

fn signed(dir: SeekDirection, secs: f64) -> f64 {
    match dir {
        SeekDirection::Forward => secs,
        SeekDirection::Backward => -secs,
    }
}

fn playback(playing: bool, pos: f64) -> MediaPlayback {
    let progress = Some(MediaPosition(Duration::from_secs_f64(pos.max(0.0))));
    if playing {
        MediaPlayback::Playing { progress }
    } else {
        MediaPlayback::Paused { progress }
    }
}

/// `file://` URL for a cover. On Windows and macOS souvlaki strips the prefix
/// and opens the rest as a path (`C:\...`); on Linux the absolute path's
/// leading slash gives the standard `file:///...` form MPRIS expects.
fn file_url(path: &Path) -> String {
    format!("file://{}", path.to_string_lossy())
}

impl Media {
    /// New track: title, artist, album, length and cover.
    pub fn track(&self, meta: &TrackMeta, playing: bool) {
        // Cover lookup and resizing happen here, off the main thread. Tracks
        // without art show the mono logo; leaving it unset would keep the
        // previous track's cover on screen.
        let cover = thumbs::thumbnail_file(&self.covers, Path::new(&meta.path), COVER)
            .or_else(|| self.logo())
            .map(|p| file_url(&p));
        // Missing fields are sent empty: the system only replaces what it's
        // given, so a track without an album would keep the previous one's.
        let title = meta.title.clone();
        let artist = meta.artist.clone().unwrap_or_default();
        let album = meta.album.clone().unwrap_or_default();
        let duration = (meta.duration > 0.0).then(|| Duration::from_secs_f64(meta.duration));
        self.on_main(move |c| {
            let _ = c.set_metadata(MediaMetadata {
                title: Some(&title),
                artist: Some(&artist),
                album: Some(&album),
                cover_url: cover.as_deref(),
                duration,
            });
            let _ = c.set_playback(playback(playing, 0.0));
        });
    }

    /// Play / pause / seek.
    pub fn playing(&self, playing: bool, pos: f64) {
        self.on_main(move |c| {
            let _ = c.set_playback(playback(playing, pos));
        });
    }

    /// The app logo as a file, written next to the cover cache once.
    fn logo(&self) -> Option<PathBuf> {
        const LOGO: &[u8] = include_bytes!("../icons/Square310x310Logo.png");
        let file = self.covers.join("mono-logo.png");
        if !file.is_file() {
            std::fs::create_dir_all(&self.covers).ok()?;
            std::fs::write(&file, LOGO).ok()?;
        }
        Some(file)
    }

    fn on_main(&self, f: impl FnOnce(&mut MediaControls) + Send + 'static) {
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            if let Some(state) = app.try_state::<MediaState>() {
                if let Some(c) = state.0.lock().as_mut() {
                    f(&mut c.0);
                }
            }
        });
    }
}
