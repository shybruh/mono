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

pub fn read_uncached(path: &Path) -> TrackMeta {
    let format = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_uppercase())
        .unwrap_or_default();
    let mut meta = TrackMeta {
        path: path.to_string_lossy().into_owned(),
        title: stem(path),
        format,
        ..Default::default()
    };
    let Ok(file) = lofty::read_from_path(path) else { return meta };
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
    }
    meta
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
