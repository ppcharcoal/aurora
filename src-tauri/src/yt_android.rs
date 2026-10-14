//! The phone version of yt.rs and tools.rs.
//!
//! A phone can't run yt-dlp and FFmpeg, so the Kotlin side
//! (aurora-mobile/android) searches and downloads with NewPipe Extractor, the
//! library behind the NewPipe app. Files are saved as the site serves them
//! (YouTube: M4A/AAC, SoundCloud: MP3), without converting, and are then
//! tagged here exactly like on Windows.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_aurora_mobile::{AuroraMobile, Hit};

use crate::yt::{cover_bytes, safe_name, score_candidate, strip_album, write_tags, AlbumResult, Downloads, SearchItem, TagMeta};

const AUDIO_EXTS: &[&str] = &["m4a", "mp3", "opus", "ogg", "webm"];

fn mobile(app: &AppHandle) -> State<'_, AuroraMobile<tauri::Wry>> {
    app.state::<AuroraMobile<tauri::Wry>>()
}

fn youtube_id(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    let host = u.host_str()?;
    if host.ends_with("youtu.be") {
        return u.path_segments()?.next().map(str::to_owned);
    }
    if host.contains("youtube.com") {
        return u.query_pairs().find(|(k, _)| k == "v").map(|(_, v)| v.into_owned());
    }
    None
}

fn to_item(h: Hit, site: &str) -> SearchItem {
    let site = if site.starts_with("youtube") { "youtube" } else { site };
    // YouTube results use the bare video id, like the desktop version.
    let id = if site == "youtube" { youtube_id(&h.url).unwrap_or(h.id) } else { h.url };
    let thumb = if site == "youtube" { Some(format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg")) } else { h.thumb };
    SearchItem {
        preview_only: site == "soundcloud" && (29_000..=31_000).contains(&h.duration_ms),
        id,
        title: h.title,
        channel: h.channel.map(|c| c.trim_end_matches(" - Topic").to_string()),
        duration_ms: h.duration_ms,
        views: h.views,
        live: false,
        site: site.to_string(),
        thumb,
    }
}

fn page_url(id: &str) -> String {
    if id.starts_with("http") {
        id.to_string()
    } else {
        format!("https://www.youtube.com/watch?v={id}")
    }
}

async fn search(app: &AppHandle, site: &str, query: &str, limit: u32) -> Result<Vec<SearchItem>, String> {
    let (app, site, query) = (app.clone(), site.to_string(), query.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let hits = mobile(&app).search(&site, &query, limit)?;
        Ok(hits.into_iter().map(|h| to_item(h, &site)).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn yt_search(app: AppHandle, query: String, limit: Option<u32>, site: Option<String>) -> Result<Vec<SearchItem>, String> {
    let n = limit.unwrap_or(24).clamp(1, 60);
    search(&app, site.as_deref().unwrap_or("youtube"), &query, n).await
}

#[tauri::command]
pub async fn yt_search_albums(_query: String) -> Result<Vec<AlbumResult>, String> {
    Err("YouTube Music album search isn't in the phone version yet. Switch the source to Music only to find albums.".into())
}

#[tauri::command]
pub async fn yt_stream_url(app: AppHandle, id: String) -> Result<String, String> {
    let url = page_url(&id);
    tauri::async_runtime::spawn_blocking(move || mobile(&app).stream(&url))
        .await
        .map_err(|e| e.to_string())?
}

/// Same idea as the desktop version: the best few uploads for a catalog song.
#[tauri::command]
pub async fn yt_find_source(
    app: AppHandle,
    artist: String,
    title: String,
    duration_ms: u64,
    site: Option<String>,
) -> Result<Vec<String>, String> {
    let site = site.unwrap_or_else(|| "youtube".into());
    let query = format!("{} - {}", artist.trim(), title.trim());
    // YouTube Music's song search finds the official audio ("Topic" uploads).
    let mut items = if site == "youtube" { search(&app, "youtube-music", &query, 8).await.unwrap_or_default() } else { Vec::new() };
    if items.is_empty() {
        items = search(&app, &site, &query, 8).await?;
    }
    let mut ranked: Vec<(i32, String)> = items
        .into_iter()
        .filter(|e| !(e.preview_only && duration_ms > 40_000))
        .map(|e| (score_candidate(&artist, &title, duration_ms, &e.title, e.channel.as_deref().unwrap_or(""), e.duration_ms), e.id))
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0));
    let good: Vec<String> = ranked.iter().filter(|(s, _)| *s > 0).take(3).map(|(_, id)| id.clone()).collect();
    let out = if good.is_empty() { ranked.into_iter().take(1).map(|(_, id)| id).collect() } else { good };
    if out.is_empty() {
        return Err(format!("Couldn't find “{title}” on {site}."));
    }
    Ok(out)
}

/// "Artist - Title (Official Video)" → ("Artist", "Title").
fn tidy(title: &str, uploader: Option<&str>) -> (String, String) {
    let mut t = title.to_string();
    for junk in [
        "(official video)", "(official music video)", "(official audio)", "(official lyric video)", "(lyrics)", "(lyric video)", "(audio)",
        "[official video]", "[official music video]", "[official audio]", "(visualizer)", "(official visualizer)", "(hd)", "(4k)", "(mv)",
    ] {
        if let Some(i) = t.to_lowercase().find(junk) {
            t.replace_range(i..i + junk.len(), "");
        }
    }
    let t = t.trim().to_string();
    for sep in [" - ", " – ", " — "] {
        if let Some((a, b)) = t.split_once(sep) {
            if !a.trim().is_empty() && !b.trim().is_empty() {
                return (a.trim().to_string(), b.trim().to_string());
            }
        }
    }
    let artist = uploader.unwrap_or("Unknown artist").trim_end_matches(" - Topic").trim().to_string();
    (artist, t)
}

fn existing(dir: &Path, stem: &str) -> Option<PathBuf> {
    AUDIO_EXTS.iter().map(|e| dir.join(format!("{stem}.{e}"))).find(|p| p.is_file())
}

#[tauri::command]
pub async fn yt_download(
    app: AppHandle,
    downloads: State<'_, Downloads>,
    id: String,
    folder: String,
    quality: String,
    tags: Option<TagMeta>,
) -> Result<String, String> {
    // Phones keep the stream as it is (no converter on board); "small" = space saver.
    let small = quality == "small";
    downloads.canceled.lock().unwrap().retain(|x| x != &id);

    // Albums: "<folder>/Artist - Album/01 - Title"; catalog singles: "<folder>/Artist - Title".
    let (dir, stem) = match &tags {
        Some(m) => match &m.album {
            Some(album) => {
                let owner = m.album_artist.as_deref().unwrap_or(&m.artist);
                (
                    Path::new(&folder).join(safe_name(&format!("{owner} - {album}"), 120)),
                    Some(safe_name(&format!("{:02} - {}", m.track_no.unwrap_or(0), m.title), 140)),
                )
            }
            None => (PathBuf::from(&folder), Some(safe_name(&format!("{} - {}", m.artist, m.title), 160))),
        },
        None => (PathBuf::from(&folder), None),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let cover = |m: &TagMeta| m.cover_url.clone();
    if let (Some(m), Some(stem)) = (&tags, &stem) {
        if let Some(path) = existing(&dir, stem) {
            let bytes = match cover(m) {
                Some(u) => cover_bytes(&downloads, &u).await,
                None => None,
            };
            let m2 = m.clone();
            let p = path.clone();
            tauri::async_runtime::spawn_blocking(move || write_tags(&p, &m2, bytes)).await.map_err(|e| e.to_string())??;
            return Ok(path.to_string_lossy().into_owned());
        }
    }

    let (app2, job, url, dir_s, stem2) = (app.clone(), id.clone(), page_url(&id), dir.to_string_lossy().into_owned(), stem.clone());
    let got = tauri::async_runtime::spawn_blocking(move || mobile(&app2).download(&job, &url, &dir_s, stem2.as_deref(), small))
        .await
        .map_err(|e| e.to_string())?;
    if downloads.canceled.lock().unwrap().contains(&id) {
        if let Ok(d) = &got {
            let _ = std::fs::remove_file(&d.path);
        }
        return Err("canceled".into());
    }
    let got = got?;
    let path = PathBuf::from(&got.path);
    // YouTube's M4A arrives in fragments; make it an ordinary file (same audio, not re-encoded).
    let p = path.clone();
    let fixed = tauri::async_runtime::spawn_blocking(move || crate::mp4fix::fix_file(&p))
        .await
        .map_err(|e| e.to_string())?;
    if let Err(e) = fixed {
        let _ = std::fs::remove_file(&path);
        return Err(format!("The download came out damaged ({e}). Please try again."));
    }

    let meta = match tags {
        Some(m) => m,
        None => {
            let (artist, title) = tidy(got.title.as_deref().unwrap_or("Untitled"), got.artist.as_deref());
            let thumb = youtube_id(&page_url(&id)).map(|v| format!("https://i.ytimg.com/vi/{v}/maxresdefault.jpg")).or(got.thumb.clone());
            TagMeta { title, artist, album: None, album_artist: None, track_no: None, track_total: None, year: None, cover_url: thumb }
        }
    };
    let bytes = match cover(&meta) {
        Some(u) => cover_bytes(&downloads, &u).await,
        None => None,
    };
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let r = write_tags(&p, &meta, bytes);
        if meta.album.is_none() {
            strip_album(&p);
        }
        r
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(got.path)
}

#[tauri::command]
pub fn yt_cancel(app: AppHandle, id: String) -> Result<(), String> {
    app.state::<Downloads>().canceled.lock().unwrap().push(id.clone());
    mobile(&app).cancel(&id);
    Ok(())
}

/* ---------------- tools: nothing to install on a phone ---------------- */

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

fn status() -> ToolsStatus {
    ToolsStatus {
        ytdlp: Some("built in (NewPipe Extractor)".into()),
        ytdlp_version: None,
        ffmpeg: Some("not needed".into()),
        js_runtime: Some("built in".into()),
        ready: true,
        can_install: false,
    }
}

#[tauri::command]
pub async fn tools_status() -> Result<ToolsStatus, String> {
    Ok(status())
}

#[tauri::command]
pub async fn tools_install() -> Result<ToolsStatus, String> {
    Ok(status())
}

#[tauri::command]
pub async fn tools_update() -> Result<String, String> {
    Ok("The phone version updates its downloader with the app.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tidies_titles() {
        assert_eq!(tidy("Daft Punk - One More Time (Official Video)", Some("Daft Punk")), ("Daft Punk".into(), "One More Time".into()));
        assert_eq!(tidy("Blinding Lights", Some("The Weeknd - Topic")), ("The Weeknd".into(), "Blinding Lights".into()));
        assert_eq!(youtube_id("https://www.youtube.com/watch?v=abc123DEF45&t=3"), Some("abc123DEF45".into()));
        assert_eq!(youtube_id("https://youtu.be/abc123DEF45"), Some("abc123DEF45".into()));
    }
}
