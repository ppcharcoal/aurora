//! Tiny JSON key/value store in the app's data folder
//! (%APPDATA%\app.aurora.player on Windows). Used for settings, playlists and download history.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use crate::rt::AppHandle;
use tauri::{Manager};

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn key_path(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    let valid = !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid {
        return Err(format!("invalid store key: {key}"));
    }
    Ok(data_dir(app)?.join(format!("{key}.json")))
}

/// Atomic write: write to a temp file, then rename over the target.
pub fn write_atomic(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_get(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    let path = key_path(&app, &key)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn store_set(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    let path = key_path(&app, &key)?;
    if value.is_null() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    write_atomic(&path, &bytes)
}
