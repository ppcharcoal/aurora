//! Local music library: folder scanning, tag reading, cover-art thumbnails.
//!
//! Performance notes:
//! - The index is cached in library.json; rescans only re-read files whose
//!   size or modification time changed.
//! - New files are parsed in parallel with rayon.
//! - Covers are extracted once per album, downscaled to 320px JPEGs, and the
//!   UI loads those small thumbnails instead of multi-MB embedded images.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use image::imageops::FilterType;
use lofty::prelude::*;
use lofty::picture::PictureType;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use walkdir::WalkDir;

use crate::store::{data_dir, write_atomic};

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "webm"];
const FOLDER_COVERS: &[&str] = &["cover", "folder", "front", "album", "albumart"];
const COVER_SIZE: u32 = 320;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrack {
    pub id: String,
    pub path: String,
    title: String,
    artist: String,
    album: String,
    album_artist: Option<String>,
    /// True when the album name came from the file's tags. Untagged files are
    /// standalone songs (their `album` is just the folder name).
    #[serde(default)]
    album_tagged: bool,
    track_no: Option<u32>,
    disc_no: Option<u32>,
    year: Option<u32>,
    duration_ms: u64,
    cover: Option<String>,
    /// Dominant colour of the cover, used for the UI accent.
    color: Option<[u8; 3]>,
    mtime: u64,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryIndex {
    #[serde(default)]
    version: u32,
    pub folders: Vec<String>,
    pub tracks: Vec<LocalTrack>,
}

/// Bump when LocalTrack gains fields that need a full re-read of tags.
// 4: re-read every song once so broken phone downloads get repaired.
const INDEX_VERSION: u32 = 4;

pub struct LibraryState {
    index: Mutex<LibraryIndex>,
    index_path: PathBuf,
    covers_dir: PathBuf,
}

#[derive(Clone, Serialize)]
struct Progress {
    done: usize,
    total: usize,
}

impl LibraryState {
    pub fn load(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let dir = data_dir(app)?;
        let index_path = dir.join("library.json");
        let covers_dir = dir.join("covers");
        fs::create_dir_all(&covers_dir)?;

        let index: LibraryIndex = fs::read(&index_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();

        // Let the webview read audio files and cover thumbnails via asset://
        let scope = app.asset_protocol_scope();
        scope.allow_directory(&covers_dir, true)?;
        for f in &index.folders {
            let _ = scope.allow_directory(f, true);
        }

        Ok(Self {
            index: Mutex::new(index),
            index_path,
            covers_dir,
        })
    }

    fn save(&self, index: &LibraryIndex) -> Result<(), String> {
        let bytes = serde_json::to_vec(index).map_err(|e| e.to_string())?;
        write_atomic(&self.index_path, &bytes)
    }
}

pub fn hash_hex(s: &str, len: usize) -> String {
    let digest = Sha256::digest(s.as_bytes());
    digest.iter().take(len / 2).map(|b| format!("{b:02x}")).collect()
}

fn file_meta(path: &Path) -> Option<(u64, u64)> {
    let m = fs::metadata(path).ok()?;
    let mtime = m
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some((mtime, m.len()))
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Saturation-weighted average colour, nudged to be readable on dark UI.
pub fn dominant_color(img: &image::DynamicImage) -> [u8; 3] {
    let small = img.resize_exact(12, 12, FilterType::Triangle).to_rgb8();
    let (mut r, mut g, mut b, mut w) = (0f32, 0f32, 0f32, 0f32);
    for p in small.pixels() {
        let [pr, pg, pb] = p.0.map(|c| c as f32);
        let max = pr.max(pg).max(pb);
        let min = pr.min(pg).min(pb);
        let sat = if max > 0.0 { (max - min) / max } else { 0.0 };
        let lum = (0.2126 * pr + 0.7152 * pg + 0.0722 * pb) / 255.0;
        // Prefer colourful mid-tones.
        let weight = 0.05 + sat * sat * (1.0 - (lum - 0.55).abs());
        r += pr * weight;
        g += pg * weight;
        b += pb * weight;
        w += weight;
    }
    let mut c = [r / w, g / w, b / w];
    let lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255.0;
    if lum < 0.35 {
        let k = 0.35 / lum.max(0.05);
        c = c.map(|v| (v * k).min(255.0));
    }
    c.map(|v| v as u8)
}

/// Thumbnail name for a picture. Keyed by the picture's own bytes, so songs
/// with the same artwork (an album) share one thumbnail and every single keeps
/// its own. Files without embedded art fall back to the folder's cover image.
fn cover_key(embedded: Option<&[u8]>, track_dir: &Path) -> String {
    match embedded {
        Some(data) => {
            let digest = Sha256::digest(data);
            let hex: String = digest.iter().take(12).map(|b| format!("{b:02x}")).collect();
            format!("a{hex}")
        }
        None => format!("f{}", hash_hex(&track_dir.to_string_lossy(), 23)),
    }
}

/// Returns (thumbnail path, colour).
fn ensure_cover(
    covers_dir: &Path,
    embedded: Option<&[u8]>,
    track_dir: &Path,
) -> Option<(String, [u8; 3])> {
    let out = covers_dir.join(format!("{}.jpg", cover_key(embedded, track_dir)));

    if out.exists() {
        let img = image::open(&out).ok()?;
        return Some((out.to_string_lossy().into_owned(), dominant_color(&img)));
    }

    let img = embedded
        .and_then(|d| image::load_from_memory(d).ok())
        .or_else(|| {
            // Fall back to cover.jpg / folder.png etc. next to the file.
            let entries = fs::read_dir(track_dir).ok()?;
            entries.flatten().find_map(|e| {
                let p = e.path();
                let stem = p.file_stem()?.to_str()?.to_ascii_lowercase();
                let ext = p.extension()?.to_str()?.to_ascii_lowercase();
                if FOLDER_COVERS.contains(&stem.as_str())
                    && ["jpg", "jpeg", "png", "webp"].contains(&ext.as_str())
                {
                    image::open(&p).ok()
                } else {
                    None
                }
            })
        })?;

    let thumb = img.resize_to_fill(COVER_SIZE, COVER_SIZE, FilterType::Lanczos3);
    let color = dominant_color(&thumb);
    let tmp = out.with_extension(format!("{}.tmp", rand::random::<u32>()));
    thumb.to_rgb8().save_with_format(&tmp, image::ImageFormat::Jpeg).ok()?;
    let _ = fs::rename(&tmp, &out);
    Some((out.to_string_lossy().into_owned(), color))
}

fn read_track(path: &Path, mtime: u64, size: u64, covers_dir: &Path) -> LocalTrack {
    let path_str = path.to_string_lossy().into_owned();
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let dir = path.parent().unwrap_or(Path::new("."));

    let mut t = LocalTrack {
        id: hash_hex(&path_str, 16),
        path: path_str,
        title: stem,
        artist: "Unknown artist".into(),
        album: dir
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Unknown album".into()),
        album_artist: None,
        album_tagged: false,
        track_no: None,
        disc_no: None,
        year: None,
        duration_ms: 0,
        cover: None,
        color: None,
        mtime,
        size,
    };

    // Songs saved by an older phone version can be fragmented M4A (length reads
    // as 0), or have their audio index knocked out of place by tagging (they
    // show up but play silence): repair them. The audio itself isn't changed.
    if let Ok(true) = crate::mp4fix::fix_file(path) {
        if let Some((m, s)) = file_meta(path) {
            t.mtime = m;
            t.size = s;
        }
    }

    let mut embedded: Option<Vec<u8>> = None;
    if let Ok(tagged) = lofty::read_from_path(path) {
        t.duration_ms = tagged.properties().duration().as_millis() as u64;
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(v) = tag.title().filter(|s| !s.trim().is_empty()) {
                t.title = v.into_owned();
            }
            if let Some(v) = tag.artist().filter(|s| !s.trim().is_empty()) {
                t.artist = v.into_owned();
            }
            if let Some(v) = tag.album().filter(|s| !s.trim().is_empty()) {
                t.album = v.into_owned();
                t.album_tagged = true;
            }
            t.album_artist = tag.get_string(&ItemKey::AlbumArtist).map(str::to_owned);
            t.track_no = tag.track();
            t.disc_no = tag.disk();
            t.year = tag
                .get_string(&ItemKey::Year)
                .or_else(|| tag.get_string(&ItemKey::RecordingDate))
                .and_then(|s| s.get(..4))
                .and_then(|s| s.parse().ok());
            let pics = tag.pictures();
            embedded = pics
                .iter()
                .find(|p| p.pic_type() == PictureType::CoverFront)
                .or_else(|| pics.first())
                .map(|p| p.data().to_vec());
        }
    }

    if let Some((cover, color)) = ensure_cover(covers_dir, embedded.as_deref(), dir) {
        t.cover = Some(cover);
        t.color = Some(color);
    }
    t
}

pub fn scan(app: &AppHandle, state: &LibraryState) -> Result<LibraryIndex, String> {
    let mut index = state.index.lock().map_err(|e| e.to_string())?.clone();
    let stale_cache = index.version < INDEX_VERSION;
    index.version = INDEX_VERSION;

    // 1. Collect every audio file under the configured folders.
    let mut files: Vec<(PathBuf, u64, u64)> = Vec::new();
    let mut seen = HashSet::new();
    for folder in &index.folders {
        for entry in WalkDir::new(folder).follow_links(true).into_iter().flatten() {
            let p = entry.path();
            let working_copy = entry.file_name().to_string_lossy().starts_with(crate::storage::TMP_PREFIX);
            if entry.file_type().is_file() && is_audio(p) && !working_copy && seen.insert(p.to_path_buf()) {
                if let Some((mtime, size)) = file_meta(p) {
                    files.push((p.to_path_buf(), mtime, size));
                }
            }
        }
    }

    // 2. Reuse unchanged entries, parse the rest in parallel.
    let previous: HashMap<String, LocalTrack> = index
        .tracks
        .drain(..)
        .map(|t| (t.path.clone(), t))
        .collect();
    let total = files.len();
    let done = AtomicUsize::new(0);
    let _ = app.emit("library://progress", Progress { done: 0, total });

    let mut tracks: Vec<LocalTrack> = files
        .par_iter()
        .map(|(path, mtime, size)| {
            let key = path.to_string_lossy();
            let t = match previous.get(key.as_ref()) {
                Some(old) if !stale_cache && old.mtime == *mtime && old.size == *size => old.clone(),
                _ => read_track(path, *mtime, *size, &state.covers_dir),
            };
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            if n % 50 == 0 {
                let _ = app.emit("library://progress", Progress { done: n, total });
            }
            t
        })
        .collect();

    tracks.sort_by(|a, b| {
        (a.artist.to_lowercase(), a.album.to_lowercase(), a.disc_no, a.track_no)
            .cmp(&(b.artist.to_lowercase(), b.album.to_lowercase(), b.disc_no, b.track_no))
    });
    index.tracks = tracks;

    // Drop thumbnails no song uses any more (e.g. the old shared ones).
    let used: HashSet<&str> = index.tracks.iter().filter_map(|t| t.cover.as_deref()).collect();
    if let Ok(entries) = fs::read_dir(&state.covers_dir) {
        for e in entries.flatten() {
            let p = e.path();
            // Fresh ones may belong to a download imported during this scan.
            let fresh = e.metadata().ok().and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .is_none_or(|age| age.as_secs() < 3600);
            if !fresh && p.extension().is_some_and(|x| x == "jpg") && !used.contains(p.to_string_lossy().as_ref()) {
                let _ = fs::remove_file(&p);
            }
        }
    }

    state.save(&index)?;
    *state.index.lock().map_err(|e| e.to_string())? = index.clone();
    let _ = app.emit("library://progress", Progress { done: total, total });
    Ok(index)
}

impl LibraryState {
    pub fn snapshot(&self) -> LibraryIndex {
        self.index.lock().map(|i| i.clone()).unwrap_or_default()
    }

    pub fn add_folders(&self, app: &AppHandle, folders: &[String]) -> Result<(), String> {
        let scope = app.asset_protocol_scope();
        let mut idx = self.index.lock().map_err(|e| e.to_string())?;
        for f in folders {
            let _ = scope.allow_directory(f, true);
            if !idx.folders.contains(f) {
                idx.folders.push(f.clone());
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub fn library_get(state: State<'_, LibraryState>) -> Result<LibraryIndex, String> {
    Ok(state.index.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
pub async fn library_add_folder(app: AppHandle, path: String) -> Result<LibraryIndex, String> {
    if !Path::new(&path).is_dir() {
        return Err("That folder does not exist.".into());
    }
    app.asset_protocol_scope()
        .allow_directory(&path, true)
        .map_err(|e| e.to_string())?;
    {
        let state = app.state::<LibraryState>();
        let mut idx = state.index.lock().map_err(|e| e.to_string())?;
        if !idx.folders.contains(&path) {
            idx.folders.push(path);
        }
    }
    library_rescan(app).await
}

#[tauri::command]
pub async fn library_remove_folder(app: AppHandle, path: String) -> Result<LibraryIndex, String> {
    {
        let state = app.state::<LibraryState>();
        let mut idx = state.index.lock().map_err(|e| e.to_string())?;
        idx.folders.retain(|f| f != &path);
    }
    library_rescan(app).await
}

/// Adds/refreshes specific files (e.g. a finished download) without a full rescan.
#[tauri::command]
pub async fn library_import(app: AppHandle, paths: Vec<String>) -> Result<LibraryIndex, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<LibraryState>();
        let fresh: Vec<LocalTrack> = paths
            .par_iter()
            .filter_map(|p| {
                let path = Path::new(p);
                let (mtime, size) = file_meta(path)?;
                Some(read_track(path, mtime, size, &state.covers_dir))
            })
            .collect();
        let mut idx = state.index.lock().map_err(|e| e.to_string())?;
        for t in fresh {
            idx.tracks.retain(|x| x.path != t.path);
            idx.tracks.push(t);
        }
        state.save(&idx)?;
        Ok(idx.clone())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn library_rescan(app: AppHandle) -> Result<LibraryIndex, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<LibraryState>();
        scan(&app, &state)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes extra copies of songs (`pairs`: [copy to delete, copy to keep]) and
/// points every playlist, play count, history entry and download record at the
/// kept copy, in all profiles. Only files in the library are touched.
#[tauri::command]
pub async fn library_remove_copies(app: AppHandle, pairs: Vec<(String, String)>) -> Result<LibraryIndex, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<LibraryState>();
        let known: HashSet<String> = state.snapshot().tracks.into_iter().map(|t| t.path).collect();
        let mut map: HashMap<String, String> = HashMap::new();
        for (remove, keep) in pairs {
            if remove == keep || !known.contains(&remove) || !known.contains(&keep) {
                continue;
            }
            if fs::remove_file(&remove).is_ok() || !Path::new(&remove).exists() {
                map.insert(hash_hex(&remove, 16), hash_hex(&keep, 16));
                map.insert(remove, keep);
            }
        }
        if !map.is_empty() {
            let data = data_dir(&app)?;
            for entry in fs::read_dir(&data).map_err(|e| e.to_string())?.flatten() {
                let p = entry.path();
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                if !name.ends_with(".json") || name == "library.json" {
                    continue;
                }
                if let Some(mut v) = crate::backup::read_json(&p) {
                    crate::backup::remap(&mut v, &map);
                    crate::backup::write_json(&p, &v)?;
                }
            }
        }
        scan(&app, &state)
    })
    .await
    .map_err(|e| e.to_string())?
}
