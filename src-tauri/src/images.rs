//! Images Aurora owns: playlist covers and profile pictures. A picked image is
//! copied into the app's data folder (as a square JPEG), so it keeps working
//! if the original file is moved or deleted. The UI stores only the file name.

use std::path::{Path, PathBuf};

use image::imageops::FilterType;
use serde::Serialize;
use crate::rt::AppHandle;
use tauri::{Manager};

use crate::store::data_dir;

pub const KINDS: &[(&str, &str, u32)] = &[
    ("playlist", "playlist-covers", 600),
    ("avatar", "avatars", 400),
    // Theme backgrounds keep their shape (fit within 1920px).
    ("wallpaper", "wallpapers", 1920),
];

pub fn kind_dir(app: &AppHandle, kind: &str) -> Result<(PathBuf, u32), String> {
    let (_, folder, size) = KINDS
        .iter()
        .find(|(k, _, _)| *k == kind)
        .ok_or_else(|| format!("Unknown image kind: {kind}"))?;
    let dir = data_dir(app)?.join(folder);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok((dir, *size))
}

/// Lets the webview display the images via asset://
pub fn allow(app: &AppHandle) -> Result<(), String> {
    for (kind, _, _) in KINDS {
        let (dir, _) = kind_dir(app, kind)?;
        app.asset_protocol_scope()
            .allow_directory(&dir, false)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Copies `source` in as the image for `owner` and returns the new file name.
#[tauri::command]
pub async fn image_store(app: AppHandle, kind: String, owner: String, source: String) -> Result<String, String> {
    let img = tauri::async_runtime::spawn_blocking(move || image::open(&source))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Couldn't open that image: {e}"))?;
    store_image(&app, &kind, &owner, img).await
}

/// Same, from a web address (e.g. your Last.fm profile picture).
#[tauri::command]
pub async fn image_store_url(app: AppHandle, kind: String, owner: String, url: String) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("Only https images are supported.".into());
    }
    let bytes = reqwest::get(&url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Couldn't download the picture: {e}"))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("That picture isn't a supported image: {e}"))?;
    store_image(&app, &kind, &owner, img).await
}

async fn store_image(app: &AppHandle, kind: &str, owner: &str, img: image::DynamicImage) -> Result<String, String> {
    if !valid_id(owner) {
        return Err("Invalid id.".into());
    }
    let (dir, size) = kind_dir(app, kind)?;
    let (kind, owner) = (kind.to_string(), owner.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let out = if kind == "wallpaper" {
            img.resize(size, size, FilterType::Lanczos3).to_rgb8()
        } else {
            img.resize_to_fill(size, size, FilterType::Lanczos3).to_rgb8()
        };
        // A fresh name each time, so the UI never shows a cached old image.
        let name = format!("{owner}-{:08x}.jpg", rand::random::<u32>());
        out
            .save_with_format(dir.join(&name), image::ImageFormat::Jpeg)
            .map_err(|e| format!("Couldn't save the image: {e}"))?;
        // Remove this owner's previous images.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n.starts_with(&format!("{owner}-")) && n != name {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        Ok(name)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes an image Aurora made. Only plain file names inside its folder.
#[tauri::command]
pub fn image_remove(app: AppHandle, kind: String, name: String) -> Result<(), String> {
    let (dir, _) = kind_dir(&app, &kind)?;
    let file = Path::new(&name).file_name().map(|f| f.to_owned());
    if let Some(f) = file {
        let _ = std::fs::remove_file(dir.join(f));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    data: String,
    playlist_covers: String,
    avatars: String,
    wallpapers: String,
    sep: String,
}

#[tauri::command]
pub fn app_paths(app: AppHandle) -> Result<AppPaths, String> {
    Ok(AppPaths {
        data: data_dir(&app)?.to_string_lossy().into_owned(),
        playlist_covers: kind_dir(&app, "playlist")?.0.to_string_lossy().into_owned(),
        avatars: kind_dir(&app, "avatar")?.0.to_string_lossy().into_owned(),
        wallpapers: kind_dir(&app, "wallpaper")?.0.to_string_lossy().into_owned(),
        sep: std::path::MAIN_SEPARATOR.to_string(),
    })
}

/// Dominant colour of a stored image (used to theme the app from a wallpaper).
#[tauri::command]
pub async fn image_color(app: AppHandle, kind: String, name: String) -> Result<[u8; 3], String> {
    let (dir, _) = kind_dir(&app, &kind)?;
    let file = Path::new(&name).file_name().ok_or("Invalid image name.")?.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let img = image::open(dir.join(file)).map_err(|e| e.to_string())?;
        Ok(crate::library::dominant_color(&img))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpace {
    free: u64,
    total: u64,
}

/// Free and total space of the drive that holds `path`.
#[tauri::command]
pub fn disk_space(path: String) -> Result<DiskSpace, String> {
    // Walk up until an existing folder (the download folder may not exist yet).
    let mut p = std::path::PathBuf::from(&path);
    while !p.exists() {
        if !p.pop() {
            return Err("Folder not found.".into());
        }
    }
    Ok(DiskSpace {
        free: fs2::available_space(&p).map_err(|e| e.to_string())?,
        total: fs2::total_space(&p).map_err(|e| e.to_string())?,
    })
}
