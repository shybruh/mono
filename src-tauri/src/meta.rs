//! Track metadata + telemetry via lofty, with a small mtime-keyed cache.

use std::collections::HashMap;
use std::path::Path;
use std::time::SystemTime;

use lofty::prelude::*;
use lofty::tag::ItemKey;
use parking_lot::Mutex;
use serde::Serialize;

pub const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "oga", "m4a", "aac", "mp4"];

pub fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackMeta {
    pub path: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<u32>,
    pub track: Option<u32>,
    pub track_total: Option<u32>,
    pub disc: Option<u32>,
    pub duration: f64,
    /// kbps
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub bit_depth: Option<u8>,
    pub format: String,
    pub rg_track_gain: Option<f32>,
    pub rg_track_peak: Option<f32>,
    pub rg_album_gain: Option<f32>,
    pub rg_album_peak: Option<f32>,
    pub has_cover: bool,
    /// Beats per minute (TBPM / BPM).
    pub bpm: Option<f32>,
    /// Musical key in standard notation, e.g. "Am", "F#", "Eb" (TKEY / INITIALKEY).
    pub key: Option<String>,
    /// File modification time, Unix seconds (used for "recently added").
    pub mtime: u64,
    /// Title / artist / track number were guessed from the file name.
    pub inferred: bool,
}

fn parse_gain(s: &str) -> Option<f32> {
    let t = s.trim().trim_end_matches(|c: char| c.is_alphabetic() || c.is_whitespace());
    t.trim().replace('\u{2212}', "-").parse::<f32>().ok()
}

fn parse_peak(s: &str) -> Option<f32> {
    s.trim().parse::<f32>().ok().filter(|p| *p > 0.0)
}

fn stem(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

#[derive(Debug, PartialEq, Default)]
pub struct FromName {
    pub track: Option<u32>,
    pub artist: Option<String>,
    pub title: String,
}

/// Guesses track number, artist and title from names like
/// "01 - Artist - Title", "03. Title", "07 Title", "Artist – Title".
pub fn parse_filename(stem: &str) -> FromName {
    let mut rest = stem.trim().replace('_', " ");
    let mut track = None;

    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if (1..=3).contains(&digits.len()) {
        let after = rest[digits.len()..].to_owned();
        let body = after.trim_start_matches([' ', '.', '-', ')', '\u{2013}']).to_owned();
        let sep = &after[..after.len() - body.len()];
        // "01 - x", "3. x", "1) x" always; "07 x" only when zero-padded,
        // so titles like "7 Rings" survive.
        let punct = sep.chars().any(|c| c != ' ');
        let padded = digits.len() >= 2 && digits.starts_with('0');
        if !body.is_empty() && !sep.is_empty() && (punct || padded) {
            track = digits.parse().ok();
            rest = body;
        }
    }

    for dash in [" - ", " \u{2013} ", " \u{2014} "] {
        if let Some(i) = rest.find(dash) {
            let artist = rest[..i].trim();
            let title = rest[i + dash.len()..].trim();
            if !artist.is_empty() && !title.is_empty() {
                return FromName { track, artist: Some(artist.to_owned()), title: title.to_owned() };
            }
        }
    }
    FromName { track, artist: None, title: rest.trim().to_owned() }
}

pub fn read_uncached(path: &Path) -> TrackMeta {
    let format = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_uppercase())
        .unwrap_or_default();
    let mut meta = TrackMeta {
        path: path.to_string_lossy().into_owned(),
        title: String::new(),
        format,
        ..Default::default()
    };
    meta.mtime = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let Ok(file) = lofty::read_from_path(path) else {
        fill_from_name(&mut meta, path);
        return meta;
    };
    let props = file.properties();
    meta.duration = props.duration().as_secs_f64();
    meta.bitrate = props.audio_bitrate().or(props.overall_bitrate());
    meta.sample_rate = props.sample_rate();
    meta.channels = props.channels();
    meta.bit_depth = props.bit_depth();

    if let Some(tag) = file.primary_tag().or_else(|| file.first_tag()) {
        if let Some(t) = tag.title().filter(|t| !t.trim().is_empty()) {
            meta.title = t.into_owned();
        }
        meta.artist = tag.artist().map(|s| s.into_owned());
        meta.album = tag.album().map(|s| s.into_owned());
        meta.genre = tag.genre().map(|s| s.into_owned());
        meta.album_artist = tag.get_string(&ItemKey::AlbumArtist).map(str::to_owned);
        meta.year = tag.year();
        meta.track = tag.track();
        meta.track_total = tag.track_total();
        meta.disc = tag.disk();
        meta.rg_track_gain = tag.get_string(&ItemKey::ReplayGainTrackGain).and_then(parse_gain);
        meta.rg_track_peak = tag.get_string(&ItemKey::ReplayGainTrackPeak).and_then(parse_peak);
        meta.rg_album_gain = tag.get_string(&ItemKey::ReplayGainAlbumGain).and_then(parse_gain);
        meta.rg_album_peak = tag.get_string(&ItemKey::ReplayGainAlbumPeak).and_then(parse_peak);
        meta.has_cover = !tag.pictures().is_empty();
        meta.bpm = tag
            .get_string(&ItemKey::IntegerBpm)
            .or_else(|| tag.get_string(&ItemKey::Bpm))
            .and_then(|s| s.trim().parse::<f32>().ok())
            .filter(|b| *b > 0.0);
        meta.key = tag
            .get_string(&ItemKey::InitialKey)
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
    }
    fill_from_name(&mut meta, path);
    meta
}

/// Fills title / artist / track number the tags didn't provide.
fn fill_from_name(meta: &mut TrackMeta, path: &Path) {
    let has_artist = meta.artist.as_deref().map(|a| !a.trim().is_empty()).unwrap_or(false);
    if !meta.title.trim().is_empty() && has_artist {
        return;
    }
    let guess = parse_filename(&stem(path));
    if meta.title.trim().is_empty() {
        meta.title = if guess.title.is_empty() { stem(path) } else { guess.title };
        meta.inferred = true;
    }
    if !has_artist {
        if let Some(a) = guess.artist {
            meta.artist = Some(a);
            meta.inferred = true;
        }
    }
    if meta.track.is_none() && guess.track.is_some() {
        meta.track = guess.track;
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_filename, FromName};

    fn f(track: Option<u32>, artist: Option<&str>, title: &str) -> FromName {
        FromName { track, artist: artist.map(str::to_owned), title: title.to_owned() }
    }

    #[test]
    fn filenames() {
        assert_eq!(parse_filename("alesso - take my breath away"), f(None, Some("alesso"), "take my breath away"));
        assert_eq!(parse_filename("01 - Daft Punk - One More Time"), f(Some(1), Some("Daft Punk"), "One More Time"));
        assert_eq!(parse_filename("03. Intro"), f(Some(3), None, "Intro"));
        assert_eq!(parse_filename("07 Closer"), f(Some(7), None, "Closer"));
        assert_eq!(parse_filename("Artist \u{2013} Song (Extended Mix)"), f(None, Some("Artist"), "Song (Extended Mix)"));
        assert_eq!(parse_filename("2049"), f(None, None, "2049"));
        assert_eq!(parse_filename("7 Rings"), f(None, None, "7 Rings"));
        assert_eq!(parse_filename("Some_Artist - Some_Song"), f(None, Some("Some Artist"), "Some Song"));
    }
}

#[derive(Default)]
pub struct MetaCache {
    map: Mutex<HashMap<String, (Option<SystemTime>, TrackMeta)>>,
}

impl MetaCache {
    pub fn get(&self, path: &Path) -> TrackMeta {
        let key = path.to_string_lossy().into_owned();
        let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        if let Some((t, m)) = self.map.lock().get(&key) {
            if *t == mtime {
                return m.clone();
            }
        }
        let m = read_uncached(path);
        self.map.lock().insert(key, (mtime, m.clone()));
        m
    }

    pub fn peek(&self, path: &str) -> Option<TrackMeta> {
        self.map.lock().get(path).map(|(_, m)| m.clone())
    }

    pub fn invalidate(&self, path: &str) {
        self.map.lock().remove(path);
    }
}

/// Linear gain for the given ReplayGain mode, clamped by the stored peak.
pub fn replaygain_linear(meta: &TrackMeta, mode: &str, preamp_db: f32) -> f32 {
    let (gain, peak) = match mode {
        "album" => (
            meta.rg_album_gain.or(meta.rg_track_gain),
            meta.rg_album_peak.or(meta.rg_track_peak),
        ),
        "track" => (
            meta.rg_track_gain.or(meta.rg_album_gain),
            meta.rg_track_peak.or(meta.rg_album_peak),
        ),
        _ => return 1.0,
    };
    let Some(db) = gain else { return 1.0 };
    let mut lin = 10f32.powf((db + preamp_db) / 20.0);
    if let Some(p) = peak {
        lin = lin.min(1.0 / p);
    }
    lin
}
