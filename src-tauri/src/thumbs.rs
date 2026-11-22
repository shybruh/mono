//! `cover://` protocol: serves album art straight to <img> tags, so covers
//! never travel through IPC as base64. `?s=N` returns a JPEG of at most N px,
//! cached on disk; `s=0` (or none) returns the original image.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use tauri::http::{Request, Response, StatusCode};

use crate::tags;

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// FNV-1a, stable across builds (the cache outlives the binary).
fn fnv(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for p in parts {
        for &b in *p {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h ^= 0xff;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn cache_key(path: &Path, size: u32) -> String {
    let (mtime, len) = std::fs::metadata(path)
        .map(|m| {
            let t = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
            (t, m.len())
        })
        .unwrap_or((0, 0));
    let h = fnv(&[
        path.to_string_lossy().as_bytes(),
        &mtime.to_le_bytes(),
        &len.to_le_bytes(),
        &size.to_le_bytes(),
    ]);
    format!("{h:016x}.jpg")
}

fn thumbnail(bytes: &[u8], size: u32) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let img = if img.width() > size || img.height() > size { img.thumbnail(size, size) } else { img };
    let mut out = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 86);
    img.to_rgb8().write_with_encoder(enc).ok()?;
    Some(out)
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "max-age=31536000, immutable")
        .body(body)
        .unwrap()
}

pub fn serve(cache: &Path, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = req.uri();
    let path = PathBuf::from(decode(uri.path().trim_start_matches('/')));
    let size: u32 = uri
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("s=")))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
        .min(2048);

    if size > 0 {
        let file = cache.join(cache_key(&path, size));
        if let Ok(b) = std::fs::read(&file) {
            return respond(StatusCode::OK, "image/jpeg", b);
        }
        if let Some((mime, bytes)) = tags::cover_bytes(&path) {
            if let Some(t) = thumbnail(&bytes, size) {
                let _ = std::fs::create_dir_all(cache);
                let _ = std::fs::write(&file, &t);
                return respond(StatusCode::OK, "image/jpeg", t);
            }
            // Undecodable image: hand the original to the webview.
            return respond(StatusCode::OK, &mime, bytes);
        }
    } else if let Some((mime, bytes)) = tags::cover_bytes(&path) {
        return respond(StatusCode::OK, &mime, bytes);
    }
    respond(StatusCode::NOT_FOUND, "text/plain", Vec::new())
}

#[cfg(test)]
mod tests {
    #[test]
    fn decodes_paths() {
        assert_eq!(super::decode("H%3A%5CMusic%5Ca%20b.mp3"), "H:\\Music\\a b.mp3");
        assert_eq!(super::decode("100%"), "100%");
    }
}
