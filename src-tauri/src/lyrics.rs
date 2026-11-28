//! Lyrics: sidecar .lrc, embedded tags, then (optionally) LRCLIB.
//! Online results are cached in the app data folder, including misses, so a
//! track is only ever looked up once. Nothing is written into the library.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use lofty::prelude::*;
use lofty::tag::ItemKey;
use serde::{Deserialize, Serialize};

use crate::meta::TrackMeta;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LyricLine {
    /// Seconds; `None` for unsynced lyrics.
    pub time: Option<f64>,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Lyrics {
    pub synced: bool,
    pub source: String,
    pub lines: Vec<LyricLine>,
}

fn parse_stamp(s: &str) -> Option<f64> {
    // mm:ss(.xx) or mm:ss:xx
    let mut parts = s.splitn(2, ':');
    let m: f64 = parts.next()?.trim().parse().ok()?;
    let rest = parts.next()?.trim().replacen(':', ".", 1);
    let sec: f64 = rest.parse().ok()?;
    Some(m * 60.0 + sec)
}

/// Parses LRC; falls back to plain lines when there are no timestamps.
pub fn parse(text: &str, source: &str) -> Option<Lyrics> {
    let mut offset = 0.0;
    let mut timed: Vec<LyricLine> = Vec::new();
    let mut plain: Vec<LyricLine> = Vec::new();

    for raw in text.lines() {
        let mut line = raw.trim_end_matches('\r');
        let mut stamps = Vec::new();
        loop {
            let t = line.trim_start();
            if !t.starts_with('[') {
                break;
            }
            let Some(end) = t.find(']') else { break };
            let tag = &t[1..end];
            if let Some(v) = tag.strip_prefix("offset:") {
                offset = v.trim().parse::<f64>().unwrap_or(0.0) / 1000.0;
            } else if let Some(ts) = parse_stamp(tag) {
                stamps.push(ts);
            } else if tag.contains(':') && stamps.is_empty() {
                // Metadata tag such as [ar:...]; skip the whole line.
                line = "";
                break;
            }
            line = &t[end + 1..];
        }
        let text = line.trim().to_owned();
        if stamps.is_empty() {
            if !raw.trim().starts_with('[') {
                plain.push(LyricLine { time: None, text });
            }
        } else {
            for ts in stamps {
                timed.push(LyricLine { time: Some((ts - offset).max(0.0)), text: text.clone() });
            }
        }
    }

    if !timed.is_empty() {
        timed.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
        return Some(Lyrics { synced: true, source: source.into(), lines: timed });
    }
    while plain.first().map(|l| l.text.is_empty()).unwrap_or(false) {
        plain.remove(0);
    }
    while plain.last().map(|l| l.text.is_empty()).unwrap_or(false) {
        plain.pop();
    }
    if plain.is_empty() {
        None
    } else {
        Some(Lyrics { synced: false, source: source.into(), lines: plain })
    }
}

fn sidecar(path: &Path) -> Option<Lyrics> {
    let lrc = path.with_extension("lrc");
    let bytes = std::fs::read(lrc).ok()?;
    parse(&String::from_utf8_lossy(&bytes), "file")
}

fn embedded(path: &Path) -> Option<Lyrics> {
    let file = crate::meta::read_tagged(path).ok()?;
    let tag = file.primary_tag().or_else(|| file.first_tag())?;
    let text = tag.get_string(&ItemKey::Lyrics)?;
    parse(text, "embedded")
}

fn key(meta: &TrackMeta) -> u64 {
    let mut h = DefaultHasher::new();
    meta.artist.hash(&mut h);
    meta.title.hash(&mut h);
    meta.album.hash(&mut h);
    (meta.duration.round() as i64).hash(&mut h);
    h.finish()
}

/// Automatic lookup result. The version prefix invalidates entries made by
/// older matching rules.
fn cache_file(dir: &Path, meta: &TrackMeta) -> PathBuf {
    dir.join("lyrics").join(format!("v2-{:016x}.json", key(meta)))
}

/// A version the user picked by hand; wins over every other source.
fn pinned_file(dir: &Path, meta: &TrackMeta) -> PathBuf {
    dir.join("lyrics").join(format!("pin-{:016x}.json", key(meta)))
}

/// What the UI needs to look a track up on LRCLIB itself.
#[derive(Serialize, Clone, Debug)]
pub struct Lookup {
    pub artist: String,
    pub title: String,
    pub album: Option<String>,
    pub duration: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Found {
    pub lyrics: Option<Lyrics>,
    /// Present when nothing local or cached was found and an online lookup
    /// should be attempted by the UI.
    pub lookup: Option<Lookup>,
}

pub fn find(meta: &TrackMeta, data_dir: &Path, online: bool) -> Found {
    if let Ok(bytes) = std::fs::read(pinned_file(data_dir, meta)) {
        if let Ok(Some(l)) = serde_json::from_slice::<Option<Lyrics>>(&bytes) {
            return Found { lyrics: Some(l), lookup: None };
        }
    }
    let path = Path::new(&meta.path);
    if let Some(l) = sidecar(path).or_else(|| embedded(path)) {
        return Found { lyrics: Some(l), lookup: None };
    }
    if !online {
        return Found { lyrics: None, lookup: None };
    }
    if let Ok(bytes) = std::fs::read(cache_file(data_dir, meta)) {
        // `null` records a previous miss.
        let lyrics = serde_json::from_slice::<Option<Lyrics>>(&bytes).ok().flatten();
        return Found { lyrics, lookup: None };
    }
    let artist = meta.artist.clone().unwrap_or_default();
    if artist.trim().is_empty() || meta.title.trim().is_empty() {
        return Found { lyrics: None, lookup: None };
    }
    Found {
        lyrics: None,
        lookup: Some(Lookup {
            artist,
            title: meta.title.clone(),
            album: meta.album.clone().filter(|a| !a.trim().is_empty()),
            duration: meta.duration,
        }),
    }
}

/// Saves user-synced lyrics as a sidecar .lrc next to the audio file and
/// drops any pinned / cached online version so the new file wins.
pub fn save_sidecar(meta: &TrackMeta, data_dir: &Path, lrc: &str) -> anyhow::Result<Option<Lyrics>> {
    let path = Path::new(&meta.path).with_extension("lrc");
    std::fs::write(&path, lrc)?;
    let _ = std::fs::remove_file(pinned_file(data_dir, meta));
    let _ = std::fs::remove_file(cache_file(data_dir, meta));
    Ok(parse(lrc, "file"))
}

/// Stores an online result (raw LRC or plain text, or a miss). `pinned`
/// records an explicit user choice that overrides local and cached lyrics.
pub fn store(meta: &TrackMeta, data_dir: &Path, raw: Option<&str>, pinned: bool) -> Option<Lyrics> {
    let parsed = raw.filter(|r| !r.trim().is_empty()).and_then(|r| parse(r, "lrclib"));
    let cache = if pinned { pinned_file(data_dir, meta) } else { cache_file(data_dir, meta) };
    if let Some(dir) = cache.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&cache, serde_json::to_vec(&parsed).unwrap_or_default());
    parsed
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn parses_synced_with_offset_and_metadata() {
        let lrc = "[ar:Someone]\n[ti:Song]\n[offset:+500]\n[00:12.00]First\n[00:15.50][01:02.25]Chorus\n\n[00:20.00]\n";
        let l = parse(lrc, "file").unwrap();
        assert!(l.synced);
        let times: Vec<f64> = l.lines.iter().map(|x| x.time.unwrap()).collect();
        assert_eq!(times, vec![11.5, 15.0, 19.5, 61.75]);
        assert_eq!(l.lines[0].text, "First");
        assert_eq!(l.lines[1].text, "Chorus");
        assert_eq!(l.lines[2].text, "");
        assert_eq!(l.lines[3].text, "Chorus");
    }

    #[test]
    fn falls_back_to_plain() {
        let l = parse("\nLine one\n\nLine two\n\n", "embedded").unwrap();
        assert!(!l.synced);
        assert_eq!(l.lines.len(), 3);
        assert_eq!(l.lines[0].text, "Line one");
    }

    #[test]
    fn empty_is_none() {
        assert!(parse("[ar:x]\n\n", "file").is_none());
    }
}
