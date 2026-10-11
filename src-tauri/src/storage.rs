//! Storage savings that never touch the audio.
//!
//! MP3 and Opus are already compressed, so zipping or "packing" songs saves
//! only a few percent and would cost time before every play. What *is* worth
//! trimming is oversized cover art embedded in every file (YouTube thumbnails
//! are often 150-400 KB per song, repeated in every track of an album).
//!
//! Safety, per file:
//! 1. the file is copied next to itself and only the copy is changed;
//! 2. the copy's audio bytes (everything after the ID3v2 tag) must be
//!    byte-for-byte identical to the original's, and the copy must still read
//!    with the same length;
//! 3. only then does the copy replace the original, in one rename.
//! Anything unexpected leaves the original untouched.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use image::codecs::jpeg::JpegEncoder;
use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture};
use lofty::prelude::*;
use lofty::tag::TagType;
use rayon::prelude::*;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::library::LibraryState;

/// Pictures above this size (or wider than MAX_SIDE) are re-saved smaller.
const BIG_PIC: usize = 120_000;
const MAX_SIDE: u32 = 800;
/// Size of the slimmed picture: plenty for a 320 px thumbnail and the 600 px views.
const TARGET_SIDE: u32 = 600;
const JPEG_QUALITY: u8 = 86;
/// Prefix of the working copy next to a song while it's being rewritten.
pub const TMP_PREFIX: &str = ".aurora-tmp-";
/// Typical size of a slimmed cover, for the estimate.
const SLIM_ESTIMATE: usize = 55_000;

/// Length of the ID3v2 tag at the start of an MP3 (0 if there is none).
fn id3v2_len(b: &[u8]) -> usize {
    if b.len() < 10 || &b[..3] != b"ID3" {
        return 0;
    }
    let size = b[6..10].iter().fold(0usize, |acc, x| (acc << 7) | (*x as usize & 0x7f));
    let footer = if b[5] & 0x10 != 0 { 10 } else { 0 };
    (10 + size + footer).min(b.len())
}

/// The audio part of an MP3: everything after the ID3v2 tag.
fn audio_part(b: &[u8]) -> &[u8] {
    &b[id3v2_len(b)..]
}

fn is_mp3(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("mp3"))
}

fn too_big(data: &[u8]) -> bool {
    if data.len() > BIG_PIC {
        return true;
    }
    image::ImageReader::new(Cursor::new(data))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok())
        .is_some_and(|(w, h)| w.max(h) > MAX_SIDE)
}

/// A smaller JPEG of the same picture, or None if it wouldn't help.
fn slim_picture(data: &[u8]) -> Option<Vec<u8>> {
    if !too_big(data) {
        return None;
    }
    let img = image::load_from_memory(data).ok()?;
    let img = if img.width().max(img.height()) > TARGET_SIDE {
        img.resize(TARGET_SIDE, TARGET_SIDE, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).encode_image(&img.to_rgb8()).ok()?;
    // Only worth a rewrite if it saves a good chunk.
    (out.len() + 20_000 < data.len()).then_some(out)
}

/// Shrinks the embedded pictures of one MP3. Returns the bytes saved.
fn slim_file(path: &Path) -> Result<u64, String> {
    if !is_mp3(path) {
        return Ok(0);
    }
    let original = fs::read(path).map_err(|e| e.to_string())?;
    let file = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let length = file.properties().duration();
    let Some(mut tag) = file.tag(TagType::Id3v2).cloned() else { return Ok(0) };

    let mut changed = false;
    for i in 0..tag.pictures().len() {
        let pic = &tag.pictures()[i];
        if let Some(small) = slim_picture(pic.data()) {
            let new = Picture::new_unchecked(pic.pic_type(), Some(MimeType::Jpeg), pic.description().map(str::to_owned), small);
            tag.set_picture(i, new);
            changed = true;
        }
    }
    if !changed {
        return Ok(0);
    }

    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // Same extension, so the tag writer knows the format. The library scan skips these.
    let tmp: PathBuf = path.with_file_name(format!("{TMP_PREFIX}{name}"));
    let result = (|| {
        fs::write(&tmp, &original).map_err(|e| e.to_string())?;
        tag.save_to_path(&tmp, WriteOptions::default()).map_err(|e| e.to_string())?;
        let rewritten = fs::read(&tmp).map_err(|e| e.to_string())?;
        if audio_part(&rewritten) != audio_part(&original) {
            return Err("audio check failed".to_string());
        }
        let check = lofty::read_from_path(&tmp).map_err(|e| e.to_string())?;
        if check.properties().duration().as_millis().abs_diff(length.as_millis()) > 50 {
            return Err("length check failed".to_string());
        }
        if rewritten.len() >= original.len() {
            return Ok(0);
        }
        // The song may have changed (or be playing) since we read it.
        if fs::metadata(path).map(|m| m.len()).ok() != Some(original.len() as u64) {
            return Err("file changed".to_string());
        }
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok((original.len() - rewritten.len()) as u64)
    })();
    let _ = fs::remove_file(&tmp);
    result
}

fn library_paths(app: &AppHandle) -> Vec<PathBuf> {
    app.state::<LibraryState>().snapshot().tracks.into_iter().map(|t| PathBuf::from(t.path)).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlimEstimate {
    files: usize,
    bytes: u64,
}

/// How much slimming cover art would save (reads tags only).
#[tauri::command]
pub async fn storage_estimate(app: AppHandle) -> Result<SlimEstimate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let files = AtomicUsize::new(0);
        let bytes = AtomicU64::new(0);
        library_paths(&app).par_iter().filter(|p| is_mp3(p)).for_each(|p| {
            let Ok(f) = lofty::read_from_path(p) else { return };
            let Some(tag) = f.tag(TagType::Id3v2) else { return };
            let save: usize = tag
                .pictures()
                .iter()
                .filter(|pic| too_big(pic.data()))
                .map(|pic| pic.data().len().saturating_sub(SLIM_ESTIMATE))
                .sum();
            if save > 20_000 {
                files.fetch_add(1, Ordering::Relaxed);
                bytes.fetch_add(save as u64, Ordering::Relaxed);
            }
        });
        Ok(SlimEstimate { files: files.into_inner(), bytes: bytes.into_inner() })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Serialize)]
struct SlimProgress {
    done: usize,
    total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlimResult {
    files: usize,
    saved: u64,
    skipped: usize,
}

/// Shrinks oversized embedded cover art in every MP3 in the library.
/// `skip` is the song that's playing right now (left alone).
#[tauri::command]
pub async fn storage_slim(app: AppHandle, skip: Option<String>) -> Result<SlimResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths: Vec<PathBuf> = library_paths(&app)
            .into_iter()
            .filter(|p| is_mp3(p) && skip.as_deref().is_none_or(|s| Path::new(s) != p.as_path()))
            .collect();
        let total = paths.len();
        let (done, files, skipped, saved) = (AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0), AtomicU64::new(0));
        // A few at a time: it's disk-bound, and the app stays responsive.
        let pool = rayon::ThreadPoolBuilder::new().num_threads(3).build().map_err(|e| e.to_string())?;
        pool.install(|| {
            paths.par_iter().for_each(|p| {
                match slim_file(p) {
                    Ok(0) => {}
                    Ok(n) => {
                        files.fetch_add(1, Ordering::Relaxed);
                        saved.fetch_add(n, Ordering::Relaxed);
                    }
                    Err(_) => {
                        skipped.fetch_add(1, Ordering::Relaxed);
                    }
                }
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 10 == 0 || n == total {
                    let _ = app.emit("storage://progress", SlimProgress { done: n, total });
                }
            })
        });
        Ok(SlimResult { files: files.into_inner(), saved: saved.into_inner(), skipped: skipped.into_inner() })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use lofty::picture::PictureType;
    use lofty::tag::Tag;

    /// A small but valid MP3: silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz).
    fn silent_mp3(frames: usize) -> Vec<u8> {
        let mut v = Vec::new();
        for i in 0..frames {
            v.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x64]);
            let _ = i;
            v.extend(std::iter::repeat_n(0u8, 413));
        }
        v
    }

    fn noisy_jpeg(side: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(side, side, |x, y| image::Rgb([(x * 7 ^ y * 13) as u8, (x * y) as u8, (x + y * 3) as u8]));
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, 98).encode_image(&img).unwrap();
        out
    }

    #[test]
    fn id3_length() {
        let mut b = b"ID3\x04\x00\x00\x00\x00\x02\x01".to_vec();
        b.resize(400, 0);
        assert_eq!(id3v2_len(&b), 10 + 257);
        assert_eq!(id3v2_len(b"\xFF\xFB\x90\x64"), 0);
    }

    #[test]
    fn slims_cover_and_keeps_audio_identical() {
        let dir = std::env::temp_dir().join(format!("aurora-slim-{}", rand::random::<u32>()));
        fs::create_dir_all(&dir).unwrap();
        let song = dir.join("Artist - Song.mp3");
        let audio = silent_mp3(400);
        fs::write(&song, &audio).unwrap();

        let big = noisy_jpeg(1400);
        assert!(big.len() > BIG_PIC);
        let mut tag = Tag::new(TagType::Id3v2);
        tag.set_title("Song".into());
        tag.set_artist("Artist".into());
        tag.push_picture(Picture::new_unchecked(PictureType::CoverFront, Some(MimeType::Jpeg), None, big.clone()));
        tag.save_to_path(&song, WriteOptions::default()).unwrap();
        let before = fs::read(&song).unwrap();
        let length = lofty::read_from_path(&song).unwrap().properties().duration();

        let saved = slim_file(&song).unwrap();
        assert!(saved > 0);
        let after = fs::read(&song).unwrap();
        assert_eq!(before.len() - after.len(), saved as usize);
        // The audio is byte-for-byte the same, and so is everything we read.
        assert_eq!(audio_part(&after), audio_part(&before));
        assert_eq!(audio_part(&after), &audio[..]);
        let f = lofty::read_from_path(&song).unwrap();
        assert_eq!(f.properties().duration(), length);
        let t = f.tag(TagType::Id3v2).unwrap();
        assert_eq!(t.title().as_deref(), Some("Song"));
        assert_eq!(t.pictures()[0].pic_type(), PictureType::CoverFront);
        let pic = image::load_from_memory(t.pictures()[0].data()).unwrap();
        assert_eq!((pic.width(), pic.height()), (TARGET_SIDE, TARGET_SIDE));
        // No temp file left, and a second run has nothing to do.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        assert_eq!(slim_file(&song).unwrap(), 0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn small_covers_are_left_alone() {
        let img = image::RgbImage::from_fn(300, 300, |x, y| image::Rgb([x as u8, y as u8, 90]));
        let mut small = Vec::new();
        JpegEncoder::new_with_quality(&mut small, 90).encode_image(&img).unwrap();
        assert!(slim_picture(&small).is_none());
    }
}

#[cfg(test)]
mod real_file {
    /// AURORA_SLIM_SAMPLE=path cargo test real_file -- --ignored
    #[test]
    #[ignore]
    fn slim_real_file() {
        let p = std::path::PathBuf::from(std::env::var("AURORA_SLIM_SAMPLE").unwrap());
        let before = std::fs::read(&p).unwrap();
        let saved = super::slim_file(&p).unwrap();
        let after = std::fs::read(&p).unwrap();
        println!("saved {saved} of {}", before.len());
        assert_eq!(super::audio_part(&before), super::audio_part(&after));
    }
}
