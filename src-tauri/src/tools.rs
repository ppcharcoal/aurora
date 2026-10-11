//! Finds or installs the external tools Aurora drives:
//!  - yt-dlp   (YouTube search + download)
//!  - FFmpeg   (audio extraction / MP3 encoding / cover embedding)
//!  - Deno or Node (yt-dlp needs a JavaScript runtime for YouTube)
//!
//! Tools installed by Aurora live in %APPDATA%\app.aurora.player\bin and are
//! preferred over anything on PATH.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::store::data_dir;

const EXE: &str = std::env::consts::EXE_SUFFIX;

const YTDLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const FFMPEG_URL: &str =
    "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
const DENO_URL: &str =
    "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip";

#[derive(Clone, Debug, Default)]
pub struct Resolved {
    pub ytdlp: Option<PathBuf>,
    /// Folder containing ffmpeg(.exe) and ffprobe(.exe).
    pub ffmpeg_dir: Option<PathBuf>,
    /// ("deno" | "node", path)
    pub js: Option<(String, PathBuf)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsStatus {
    ytdlp: Option<String>,
    ytdlp_version: Option<String>,
    ffmpeg: Option<String>,
    js_runtime: Option<String>,
    ready: bool,
    can_install: bool,
}

#[derive(Clone, Serialize)]
struct InstallProgress {
    step: String,
    done: u64,
    total: u64,
}

pub fn bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("bin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn exe(name: &str) -> String {
    format!("{name}{EXE}")
}

fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(exe(name)))
        .find(|p| p.is_file())
}

fn find(bin: &Path, name: &str) -> Option<PathBuf> {
    let local = bin.join(exe(name));
    if local.is_file() {
        Some(local)
    } else {
        on_path(name)
    }
}

pub fn resolve(app: &AppHandle) -> Result<Resolved, String> {
    let bin = bin_dir(app)?;
    let ffmpeg_dir = find(&bin, "ffmpeg").and_then(|p| {
        let dir = p.parent()?.to_path_buf();
        dir.join(exe("ffprobe")).is_file().then_some(dir)
    });
    let js = find(&bin, "deno")
        .map(|p| ("deno".to_string(), p))
        .or_else(|| on_path("node").map(|p| ("node".to_string(), p)));
    Ok(Resolved {
        ytdlp: find(&bin, "yt-dlp"),
        ffmpeg_dir,
        js,
    })
}

/// A Command with no console window and UTF-8 output.
pub fn command(program: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .env("NO_COLOR", "1")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// yt-dlp arguments every invocation needs (JS runtime + FFmpeg location).
pub fn common_args(r: &Resolved) -> Vec<String> {
    let mut a = vec!["--no-colors".to_string(), "--ignore-config".to_string()];
    if let Some((kind, path)) = &r.js {
        a.push("--js-runtimes".into());
        a.push(format!("{kind}:{}", path.display()));
    }
    if let Some(dir) = &r.ffmpeg_dir {
        a.push("--ffmpeg-location".into());
        a.push(dir.display().to_string());
    }
    a
}

async fn ytdlp_version(path: &Path) -> Option<String> {
    let out = command(path).arg("--version").output().await.ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
pub async fn tools_status(app: AppHandle) -> Result<ToolsStatus, String> {
    let r = resolve(&app)?;
    let version = match &r.ytdlp {
        Some(p) => ytdlp_version(p).await,
        None => None,
    };
    Ok(ToolsStatus {
        ready: version.is_some() && r.ffmpeg_dir.is_some() && r.js.is_some(),
        ytdlp: r.ytdlp.map(|p| p.display().to_string()),
        ytdlp_version: version,
        ffmpeg: r.ffmpeg_dir.map(|p| p.display().to_string()),
        js_runtime: r.js.map(|(k, p)| format!("{k} ({})", p.display())),
        can_install: cfg!(windows),
    })
}

async fn download(app: &AppHandle, step: &str, url: &str, dest: &Path) -> Result<(), String> {
    let mut res = reqwest::Client::builder()
        .user_agent("Aurora")
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Download of {step} failed: {e}"))?;
    let total = res.content_length().unwrap_or(0);
    let tmp = dest.with_extension("download");
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut done = 0u64;
    let mut last_emit = 0u64;
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if done - last_emit > 512 * 1024 || done == total {
            last_emit = done;
            let _ = app.emit(
                "tools://progress",
                InstallProgress { step: step.into(), done, total },
            );
        }
    }
    drop(file);
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

/// Extracts the named files (matched by file name, any folder) from a zip.
fn extract(zip_path: &Path, names: &[&str], into: &Path) -> Result<(), String> {
    let f = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let file_name = Path::new(entry.name())
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if names.contains(&file_name.as_str()) {
            let mut out = std::fs::File::create(into.join(&file_name)).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn tools_install(app: AppHandle) -> Result<ToolsStatus, String> {
    if !cfg!(windows) {
        return Err("Automatic install is Windows-only. Install yt-dlp, ffmpeg and deno with your package manager.".into());
    }
    let bin = bin_dir(&app)?;
    let r = resolve(&app)?;

    if r.ytdlp.is_none() {
        download(&app, "yt-dlp", YTDLP_URL, &bin.join("yt-dlp.exe")).await?;
    }
    if r.ffmpeg_dir.is_none() {
        let zip = bin.join("ffmpeg.zip");
        download(&app, "FFmpeg", FFMPEG_URL, &zip).await?;
        let (z, b) = (zip.clone(), bin.clone());
        tauri::async_runtime::spawn_blocking(move || extract(&z, &["ffmpeg.exe", "ffprobe.exe"], &b))
            .await
            .map_err(|e| e.to_string())??;
        let _ = std::fs::remove_file(zip);
    }
    if r.js.is_none() {
        let zip = bin.join("deno.zip");
        download(&app, "Deno", DENO_URL, &zip).await?;
        let (z, b) = (zip.clone(), bin.clone());
        tauri::async_runtime::spawn_blocking(move || extract(&z, &["deno.exe"], &b))
            .await
            .map_err(|e| e.to_string())??;
        let _ = std::fs::remove_file(zip);
    }
    tools_status(app).await
}

/// YouTube changes often; a fresh yt-dlp fixes most download errors.
#[tauri::command]
pub async fn tools_update(app: AppHandle) -> Result<String, String> {
    let r = resolve(&app)?;
    let path = r.ytdlp.ok_or("yt-dlp is not installed.")?;
    let bin = bin_dir(&app)?;
    if path.starts_with(&bin) {
        // Our own copy: just fetch the latest release over it.
        download(&app, "yt-dlp", YTDLP_URL, &path).await?;
        return Ok(ytdlp_version(&path).await.unwrap_or_default());
    }
    let out = command(&path).arg("-U").output().await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        Ok(ytdlp_version(&path).await.unwrap_or_default())
    } else {
        Err(text.trim().lines().last().unwrap_or("Update failed").to_string())
    }
}
