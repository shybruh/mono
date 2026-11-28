//! Directory-native "crates": watched roots, their sub-folders and any
//! .m3u / .m3u8 files inside them. Nothing is imported or copied.

use std::path::{Path, PathBuf};
use std::time::Duration;

use notify_debouncer_mini::notify::event::{AccessKind, AccessMode};
use notify_debouncer_mini::notify::{self, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::meta::{is_audio, MetaCache, TrackMeta};
use crate::AppState;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CrateNode {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub children: Vec<CrateNode>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub path: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub dir: String,
}

pub fn is_playlist(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("m3u") | Some("m3u8")
    )
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn natural_key(s: &str) -> Vec<(u64, String)> {
    // Split into (number, text) runs so "2 - x" sorts before "10 - x".
    let mut out = Vec::new();
    let mut num = String::new();
    let mut txt = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            if !txt.is_empty() {
                out.push((0, std::mem::take(&mut txt).to_lowercase()));
            }
            num.push(c);
        } else {
            if !num.is_empty() {
                out.push((num.parse().unwrap_or(0), String::new()));
                num.clear();
            }
            txt.push(c);
        }
    }
    if !num.is_empty() {
        out.push((num.parse().unwrap_or(0), String::new()));
    }
    if !txt.is_empty() {
        out.push((0, txt.to_lowercase()));
    }
    out
}

fn build_node(dir: &Path, depth: usize, is_root: bool) -> Option<CrateNode> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut dirs = Vec::new();
    let mut playlists = Vec::new();
    let mut has_audio = false;
    for entry in rd.flatten() {
        let p = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            if !name_of(&p).starts_with('.') {
                dirs.push(p);
            }
        } else if is_playlist(&p) {
            playlists.push(p);
        } else if !has_audio && is_audio(&p) {
            has_audio = true;
        }
    }
    dirs.sort_by_key(|p| natural_key(&name_of(p)));
    playlists.sort_by_key(|p| natural_key(&name_of(p)));

    let mut children: Vec<CrateNode> = Vec::new();
    if depth < 12 {
        children.extend(dirs.iter().filter_map(|d| build_node(d, depth + 1, false)));
    }
    children.extend(playlists.iter().map(|p| CrateNode {
        name: p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        path: p.to_string_lossy().into_owned(),
        kind: "playlist",
        children: Vec::new(),
    }));

    if !is_root && !has_audio && children.is_empty() {
        return None;
    }
    Some(CrateNode { name: name_of(dir), path: dir.to_string_lossy().into_owned(), kind: "folder", children })
}

pub fn crate_tree(roots: &[String]) -> Vec<CrateNode> {
    roots.iter().filter_map(|r| build_node(Path::new(r), 0, true)).collect()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn read_playlist(path: &Path) -> Vec<PathBuf> {
    let Ok(bytes) = std::fs::read(path) else { return Vec::new() };
    let text = String::from_utf8_lossy(&bytes);
    let base = path.parent().unwrap_or(Path::new("."));
    text.lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}'))
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            if let Some(rest) = l.strip_prefix("file:///") {
                PathBuf::from(percent_decode(rest))
            } else if let Some(rest) = l.strip_prefix("file://") {
                PathBuf::from(percent_decode(rest))
            } else {
                let p = PathBuf::from(l);
                if p.is_absolute() {
                    p
                } else {
                    base.join(p)
                }
            }
        })
        .filter(|p| p.is_file())
        .collect()
}

pub fn write_playlist(path: &Path, tracks: &[String]) -> anyhow::Result<()> {
    let base = path.parent().unwrap_or(Path::new("."));
    let mut out = String::from("#EXTM3U\n");
    for t in tracks {
        let tp = Path::new(t);
        let rel = tp.strip_prefix(base).map(|p| p.to_path_buf()).unwrap_or_else(|_| tp.to_path_buf());
        out.push_str(&rel.to_string_lossy());
        out.push('\n');
    }
    std::fs::write(path, out)?;
    Ok(())
}

/// Reads metadata for many files on a few threads.
pub fn metas(cache: &MetaCache, paths: &[PathBuf]) -> Vec<TrackMeta> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
    let chunk = paths.len().div_ceil(threads).max(1);
    std::thread::scope(|s| {
        let handles: Vec<_> = paths
            .chunks(chunk)
            .map(|c| s.spawn(move || c.iter().map(|p| cache.get(p)).collect::<Vec<_>>()))
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    })
}

pub fn tracks_in(cache: &MetaCache, path: &Path) -> Vec<TrackMeta> {
    if path.is_file() && is_playlist(path) {
        return metas(cache, &read_playlist(path));
    }
    let direct: Vec<PathBuf> = std::fs::read_dir(path)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_file() && is_audio(p)).collect())
        .unwrap_or_default();
    let files = if direct.is_empty() {
        WalkDir::new(path)
            .follow_links(true)
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file() && is_audio(e.path()))
            .map(|e| e.into_path())
            .collect()
    } else {
        direct
    };
    let mut list = metas(cache, &files);
    list.sort_by(|a, b| {
        let da = Path::new(&a.path).parent().map(|p| p.to_path_buf());
        let db = Path::new(&b.path).parent().map(|p| p.to_path_buf());
        da.cmp(&db)
            .then(a.disc.unwrap_or(1).cmp(&b.disc.unwrap_or(1)))
            .then(a.track.unwrap_or(u32::MAX).cmp(&b.track.unwrap_or(u32::MAX)))
            .then_with(|| natural_key(&name_of(Path::new(&a.path))).cmp(&natural_key(&name_of(Path::new(&b.path)))))
    });
    list
}

pub fn all_files(roots: &[String]) -> Vec<PathBuf> {
    roots
        .iter()
        .flat_map(|r| {
            WalkDir::new(r)
                .follow_links(true)
                .into_iter()
                .flatten()
                .filter(|e| e.file_type().is_file() && is_audio(e.path()))
                .map(|e| e.into_path())
        })
        .collect()
}

pub fn index(cache: &MetaCache, roots: &[String]) -> Vec<IndexEntry> {
    all_files(roots)
        .into_iter()
        .map(|p| {
            let ps = p.to_string_lossy().into_owned();
            let dir = p.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
            match cache.peek(&ps) {
                Some(m) => IndexEntry { path: ps, title: m.title, artist: m.artist, album: m.album, dir },
                None => IndexEntry {
                    title: p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                    path: ps,
                    artist: None,
                    album: None,
                    dir,
                },
            }
        })
        .collect()
}

/// Warms the metadata cache for every file under the roots, then tells the UI.
pub fn spawn_indexer(app: AppHandle, roots: Vec<String>) {
    std::thread::Builder::new()
        .name("mono-indexer".into())
        .spawn(move || {
            let state = app.state::<AppState>();
            let files = all_files(&roots);
            for chunk in files.chunks(256) {
                metas(&state.meta, chunk);
            }
            let _ = app.emit("library-indexed", files.len());
        })
        .ok();
}

pub fn watch(app: &AppHandle, roots: &[String]) -> Option<RecommendedWatcher> {
    let (tx, rx) = crossbeam_channel::unbounded::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        // Reads aren't changes. Linux and Android report every open and close,
        // so counting them made each rescan (which reads the files) trigger
        // the next one, forever. A file closed after writing still counts.
        if let EventKind::Access(kind) = ev.kind {
            if kind != AccessKind::Close(AccessMode::Write) {
                return;
            }
        }
        for p in ev.paths {
            let _ = tx.send(p);
        }
    })
    .ok()?;
    for r in roots {
        let _ = watcher.watch(Path::new(r), RecursiveMode::Recursive);
    }

    // Report once things have been quiet for 600 ms. The thread ends when the
    // watcher is dropped (folders changed or app closed).
    let handle = app.clone();
    let _ = std::thread::Builder::new().name("mono-watch".into()).spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut paths = vec![first];
            while let Ok(p) = rx.recv_timeout(Duration::from_millis(600)) {
                paths.push(p);
            }
            let state = handle.state::<AppState>();
            let mut dirs: Vec<String> = Vec::new();
            for path in paths {
                let p = path.to_string_lossy().into_owned();
                state.meta.invalidate(&p);
                let d = path.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
                if !dirs.contains(&d) {
                    dirs.push(d);
                }
                if !dirs.contains(&p) {
                    dirs.push(p);
                }
            }
            let _ = handle.emit("library-changed", dirs);
        }
    });
    Some(watcher)
}
