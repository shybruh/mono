//! Inline tag + cover-art patching.

use std::path::Path;

use anyhow::{anyhow, Result};
use base64::Engine as _;
use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::{ItemKey, Tag};
use serde::Deserialize;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TagEdit {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<u32>,
    pub track: Option<u32>,
    pub track_total: Option<u32>,
    pub disc: Option<u32>,
    pub bpm: Option<f32>,
    pub key: Option<String>,
}

fn with_tag<F: FnOnce(&mut Tag)>(path: &Path, f: F) -> Result<()> {
    let mut file = lofty::read_from_path(path).map_err(|e| anyhow!("read tags: {e}"))?;
    if file.primary_tag().is_none() {
        let tt = file.primary_tag_type();
        file.insert_tag(Tag::new(tt));
    }
    let tag = file.primary_tag_mut().ok_or_else(|| anyhow!("no writable tag"))?;
    f(tag);
    tag.save_to_path(path, WriteOptions::default()).map_err(|e| anyhow!("write tags: {e}"))?;
    Ok(())
}

fn set_str(tag: &mut Tag, key: ItemKey, v: &Option<String>) {
    match v.as_deref().map(str::trim) {
        Some("") | None => tag.remove_key(&key),
        Some(s) => {
            tag.insert_text(key, s.to_owned());
        }
    }
}

pub fn write(path: &Path, e: &TagEdit) -> Result<()> {
    with_tag(path, |tag| {
        set_str(tag, ItemKey::TrackTitle, &e.title);
        set_str(tag, ItemKey::TrackArtist, &e.artist);
        set_str(tag, ItemKey::AlbumTitle, &e.album);
        set_str(tag, ItemKey::AlbumArtist, &e.album_artist);
        set_str(tag, ItemKey::Genre, &e.genre);
        match e.year {
            Some(y) if y > 0 => tag.set_year(y),
            _ => tag.remove_year(),
        }
        match e.track {
            Some(t) if t > 0 => tag.set_track(t),
            _ => tag.remove_track(),
        }
        match e.track_total {
            Some(t) if t > 0 => tag.set_track_total(t),
            _ => tag.remove_track_total(),
        }
        match e.disc {
            Some(d) if d > 0 => tag.set_disk(d),
            _ => tag.remove_disk(),
        }
        set_bpm(tag, e.bpm);
        set_str(tag, ItemKey::InitialKey, &e.key);
    })
}

/// ID3 stores whole-number BPM (TBPM); Vorbis / MP4 keep the decimal form.
fn set_bpm(tag: &mut Tag, bpm: Option<f32>) {
    match bpm.filter(|b| *b > 0.0) {
        Some(b) => {
            tag.insert_text(ItemKey::IntegerBpm, format!("{}", b.round() as u32));
            tag.insert_text(ItemKey::Bpm, format!("{:.1}", b).trim_end_matches(".0").to_owned());
        }
        None => {
            tag.remove_key(&ItemKey::IntegerBpm);
            tag.remove_key(&ItemKey::Bpm);
        }
    }
}

/// Writes only BPM and key (used by analysis).
pub fn write_bpm_key(path: &Path, bpm: Option<f32>, key: Option<&str>) -> Result<()> {
    with_tag(path, |tag| {
        if bpm.is_some() {
            set_bpm(tag, bpm);
        }
        if let Some(k) = key {
            tag.insert_text(ItemKey::InitialKey, k.to_owned());
        }
    })
}

pub fn renumber(paths: &[String]) -> Result<()> {
    let total = paths.len() as u32;
    for (i, p) in paths.iter().enumerate() {
        with_tag(Path::new(p), |tag| {
            tag.set_track(i as u32 + 1);
            tag.set_track_total(total);
        })?;
    }
    Ok(())
}

fn mime_for(path: &Path) -> MimeType {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => MimeType::Png,
        Some("gif") => MimeType::Gif,
        Some("bmp") => MimeType::Bmp,
        Some("tif") | Some("tiff") => MimeType::Tiff,
        _ => MimeType::Jpeg,
    }
}

pub fn set_cover(path: &Path, image: &Path) -> Result<()> {
    let data = std::fs::read(image)?;
    let mime = mime_for(image);
    with_tag(path, |tag| {
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(Picture::new_unchecked(PictureType::CoverFront, Some(mime), None, data));
    })
}

/// Embeds cover art supplied as bytes (e.g. downloaded by the UI).
pub fn set_cover_bytes(path: &Path, data: Vec<u8>, mime: &str) -> Result<()> {
    if data.is_empty() {
        return Err(anyhow!("empty image"));
    }
    let mime = match mime {
        "image/png" => MimeType::Png,
        "image/gif" => MimeType::Gif,
        "image/bmp" => MimeType::Bmp,
        _ => MimeType::Jpeg,
    };
    with_tag(path, |tag| {
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(Picture::new_unchecked(PictureType::CoverFront, Some(mime), None, data));
    })
}

pub fn remove_cover(path: &Path) -> Result<()> {
    with_tag(path, |tag| {
        while !tag.pictures().is_empty() {
            tag.remove_picture(0);
        }
    })
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Embedded front cover, else any embedded picture, else a folder image.
pub fn cover(path: &Path) -> Option<String> {
    cover_bytes(path).map(|(mime, bytes)| data_url(&mime, &bytes))
}

/// The cover image as (mime type, bytes).
pub fn cover_bytes(path: &Path) -> Option<(String, Vec<u8>)> {
    if let Ok(file) = lofty::read_from_path(path) {
        if let Some(tag) = file.primary_tag().or_else(|| file.first_tag()) {
            let pics = tag.pictures();
            let pic = pics
                .iter()
                .find(|p| p.pic_type() == PictureType::CoverFront)
                .or_else(|| pics.first());
            if let Some(p) = pic {
                let mime = p.mime_type().map(|m| m.as_str().to_owned()).unwrap_or_else(|| "image/jpeg".into());
                return Some((mime, p.data().to_vec()));
            }
        }
    }
    let dir = path.parent()?;
    for name in ["cover", "folder", "front", "album", "Cover", "Folder", "Front", "AlbumArt"] {
        for ext in ["jpg", "jpeg", "png", "webp"] {
            let p = dir.join(format!("{name}.{ext}"));
            if let Ok(bytes) = std::fs::read(&p) {
                let mime = if ext == "png" { "image/png" } else if ext == "webp" { "image/webp" } else { "image/jpeg" };
                return Some((mime.into(), bytes));
            }
        }
    }
    None
}
