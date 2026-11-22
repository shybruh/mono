//! Smart crates: saved rules evaluated against the whole library.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::meta::TrackMeta;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    /// title, artist, album, albumArtist, genre, year, bpm, key, format,
    /// bitrate, duration (minutes), added (days ago), folder.
    pub field: String,
    /// contains, is, isNot, startsWith, gt, lt, between, within.
    pub op: String,
    pub value: String,
    #[serde(default)]
    pub value2: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SmartDef {
    pub rules: Vec<Rule>,
    #[serde(default = "yes")]
    pub match_all: bool,
    #[serde(default)]
    pub limit: Option<usize>,
}

fn yes() -> bool {
    true
}

fn text_of(m: &TrackMeta, field: &str) -> Option<String> {
    Some(match field {
        "title" => m.title.clone(),
        "artist" => m.artist.clone()?,
        "album" => m.album.clone()?,
        "albumArtist" => m.album_artist.clone()?,
        "genre" => m.genre.clone()?,
        "key" => m.key.clone()?,
        "format" => m.format.clone(),
        "folder" => std::path::Path::new(&m.path).parent()?.to_string_lossy().into_owned(),
        _ => return None,
    })
}

fn number_of(m: &TrackMeta, field: &str) -> Option<f64> {
    match field {
        "year" => m.year.map(f64::from),
        "bpm" => m.bpm.map(f64::from),
        "bitrate" => m.bitrate.map(f64::from),
        "duration" => Some(m.duration / 60.0),
        "added" => {
            let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
            (m.mtime > 0).then(|| (now.saturating_sub(m.mtime)) as f64 / 86_400.0)
        }
        _ => None,
    }
}

fn matches(m: &TrackMeta, r: &Rule) -> bool {
    let v = r.value.trim().to_lowercase();
    if let Some(n) = number_of(m, &r.field) {
        let a: f64 = r.value.trim().parse().unwrap_or(f64::NAN);
        let b: f64 = r.value2.as_deref().and_then(|s| s.trim().parse().ok()).unwrap_or(f64::NAN);
        return match r.op.as_str() {
            "is" => (n - a).abs() < 0.5,
            "isNot" => (n - a).abs() >= 0.5,
            "gt" => n > a,
            "lt" => n < a,
            "between" => n >= a.min(b) && n <= a.max(b),
            // "added within N days"
            "within" => n <= a,
            _ => false,
        };
    }
    if matches!(r.field.as_str(), "year" | "bpm" | "bitrate" | "duration" | "added") {
        // Numeric field the track doesn't have: only "is not" can match.
        return r.op == "isNot";
    }
    let t = text_of(m, &r.field).unwrap_or_default().to_lowercase();
    match r.op.as_str() {
        "contains" => t.contains(&v),
        "is" => t == v,
        "isNot" => t != v,
        "startsWith" => t.starts_with(&v),
        _ => false,
    }
}

pub fn filter(def: &SmartDef, metas: Vec<TrackMeta>) -> Vec<TrackMeta> {
    let rules: Vec<&Rule> = def.rules.iter().filter(|r| !r.field.is_empty()).collect();
    let mut out: Vec<TrackMeta> = metas
        .into_iter()
        .filter(|m| {
            if rules.is_empty() {
                return true;
            }
            if def.match_all {
                rules.iter().all(|r| matches(m, r))
            } else {
                rules.iter().any(|r| matches(m, r))
            }
        })
        .collect();
    // Newest first, which suits "recently added" style crates.
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    if let Some(n) = def.limit.filter(|n| *n > 0) {
        out.truncate(n);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(genre: &str, bpm: f32) -> TrackMeta {
        TrackMeta { title: "x".into(), genre: Some(genre.into()), bpm: Some(bpm), ..Default::default() }
    }

    #[test]
    fn all_and_any() {
        let rules = vec![
            Rule { field: "genre".into(), op: "contains".into(), value: "house".into(), value2: None },
            Rule { field: "bpm".into(), op: "between".into(), value: "120".into(), value2: Some("128".into()) },
        ];
        let tracks = vec![track("Deep House", 124.0), track("Deep House", 140.0), track("Techno", 125.0)];
        let all = filter(&SmartDef { rules: rules.clone(), match_all: true, limit: None }, tracks.clone());
        assert_eq!(all.len(), 1);
        let any = filter(&SmartDef { rules, match_all: false, limit: None }, tracks);
        assert_eq!(any.len(), 3);
    }
}
