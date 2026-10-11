//! YouTube search and MP3 download through yt-dlp.

use std::collections::HashMap;
use std::path::Path;
#[cfg(not(aurora_android))]
use std::path::PathBuf;
#[cfg(not(aurora_android))]
use std::process::Stdio;
use std::sync::Mutex;
#[cfg(not(aurora_android))]
use std::time::Duration;

use serde::{Deserialize, Serialize};
#[cfg(not(aurora_android))]
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(not(aurora_android))]
use tokio::io::{AsyncBufReadExt, BufReader};

#[cfg(not(aurora_android))]
use crate::tools::{command, common_args, resolve};

#[derive(Default)]
pub struct Downloads {
    #[cfg_attr(aurora_android, allow(dead_code))]
    running: Mutex<HashMap<String, u32>>,
    pub(crate) canceled: Mutex<Vec<String>>,
    /// Album cover bytes by URL, so a 12-track album fetches its cover once.
    covers: Mutex<HashMap<String, Vec<u8>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchItem {
    /// YouTube video id, or the page URL for other sites.
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) channel: Option<String>,
    pub(crate) duration_ms: u64,
    pub(crate) views: Option<u64>,
    pub(crate) live: bool,
    pub(crate) site: String,
    pub(crate) thumb: Option<String>,
    /// SoundCloud Go+ tracks only offer a 30-second clip without a subscription.
    pub(crate) preview_only: bool,
}

#[cfg(not(aurora_android))]
#[derive(Deserialize)]
struct FlatEntry {
    id: Option<String>,
    title: Option<String>,
    channel: Option<String>,
    uploader: Option<String>,
    duration: Option<f64>,
    view_count: Option<u64>,
    live_status: Option<String>,
    ie_key: Option<String>,
    url: Option<String>,
    webpage_url: Option<String>,
    #[serde(default)]
    thumbnails: Vec<Thumb>,
    #[serde(default)]
    artists: Vec<String>,
}

#[cfg(not(aurora_android))]
#[derive(Deserialize)]
struct Thumb {
    url: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[cfg(not(aurora_android))]
#[derive(Deserialize)]
struct FlatPlaylist {
    #[serde(default)]
    entries: Vec<Option<FlatEntry>>,
    title: Option<String>,
    id: Option<String>,
    uploader: Option<String>,
    channel: Option<String>,
    playlist_uploader: Option<String>,
    #[serde(default)]
    thumbnails: Vec<Thumb>,
    release_year: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumTrack {
    pub id: String,
    pub title: String,
    pub duration_ms: u64,
    /// Track artist when it differs per track (compilations). Catalog results only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    /// 30-second preview clip (catalog albums only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumResult {
    pub id: String,
    pub url: String,
    pub title: String,
    pub artist: String,
    pub thumb: Option<String>,
    pub year: Option<u32>,
    pub tracks: Vec<AlbumTrack>,
}

/// Tags written into a downloaded file. With `album` set it's an album track
/// (saved under "Artist - Album/"), otherwise a standalone song.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TagMeta {
    pub(crate) title: String,
    pub(crate) artist: String,
    pub(crate) album: Option<String>,
    pub(crate) album_artist: Option<String>,
    pub(crate) track_no: Option<u32>,
    pub(crate) track_total: Option<u32>,
    pub(crate) year: Option<u32>,
    pub(crate) cover_url: Option<String>,
}

#[cfg(not(aurora_android))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    percent: f64,
    speed: String,
    eta: String,
}

#[cfg(not(aurora_android))]
const DOWNLOAD_ATTEMPTS: u32 = 3;

#[cfg(not(aurora_android))]
#[derive(Clone, Serialize)]
struct RetryInfo {
    id: String,
    attempt: u32,
    of: u32,
}

#[cfg(not(aurora_android))]
/// Errors worth another try: 403s, server errors, timeouts, dropped connections.
fn is_transient(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    ["http error 403", "http error 5", "timed out", "connection reset", "incompleteread", "unable to download video data", "sign in to confirm", "temporary failure", "remote end closed"]
        .iter()
        .any(|w| s.contains(w))
}

#[cfg(not(aurora_android))]
/// Picks the most useful line out of yt-dlp's stderr.
fn error_from(stderr: &str) -> String {
    let line = stderr
        .lines()
        .rev()
        .find(|l| l.starts_with("ERROR"))
        .or_else(|| stderr.lines().rev().find(|l| !l.trim().is_empty()))
        .unwrap_or("yt-dlp failed")
        .trim_start_matches("ERROR: ")
        .to_string();
    if line.contains("Sign in to confirm") || line.contains("HTTP Error 403") {
        format!("{line} (tried {DOWNLOAD_ATTEMPTS} times). If this keeps happening, use Settings → Update yt-dlp.")
    } else {
        line
    }
}

#[cfg(not(aurora_android))]
fn not_ready() -> String {
    "yt-dlp isn't set up yet. Open Settings → Download tools and press Install.".into()
}

#[cfg(not(aurora_android))]
/// yt-dlp search prefix for each supported site.
fn search_prefix(site: &str) -> Result<&'static str, String> {
    match site {
        "youtube" => Ok("ytsearch"),
        "soundcloud" => Ok("scsearch"),
        _ => Err(format!("Unsupported site: {site}")),
    }
}

#[cfg(not(aurora_android))]
fn best_thumb(t: &[Thumb]) -> Option<String> {
    t.iter()
        .filter(|t| t.url.is_some())
        .max_by_key(|t| t.width.unwrap_or(0) * t.height.unwrap_or(0))
        .and_then(|t| t.url.clone())
}

#[cfg(not(aurora_android))]
fn to_item(e: FlatEntry, site: &str) -> Option<SearchItem> {
    let duration_ms = (e.duration.unwrap_or(0.0) * 1000.0) as u64;
    let (id, thumb) = if site == "youtube" {
        let id = e.id?;
        let thumb = Some(format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"));
        (id, thumb)
    } else {
        (e.webpage_url.clone().or(e.url.clone())?, best_thumb(&e.thumbnails))
    };
    Some(SearchItem {
        id,
        title: e.title.unwrap_or_default(),
        channel: e.artists.first().cloned().or(e.channel).or(e.uploader),
        duration_ms,
        views: e.view_count,
        live: e.live_status.as_deref() == Some("is_live"),
        site: site.to_string(),
        thumb,
        preview_only: site == "soundcloud" && (29_000..=31_000).contains(&duration_ms),
    })
}

#[cfg(not(aurora_android))]
async fn search_site(r: &crate::tools::Resolved, ytdlp: &Path, query: &str, n: u32, site: &str) -> Result<Vec<SearchItem>, String> {
    let prefix = search_prefix(site)?;
    let list = flat_json(r, ytdlp, &format!("{prefix}{n}:{}", query.trim()), 45).await?;
    Ok(list
        .entries
        .into_iter()
        .flatten()
        .filter(|e| site != "youtube" || e.ie_key.as_deref().map_or(true, |k| k == "Youtube"))
        .filter_map(|e| to_item(e, site))
        .collect())
}

#[cfg(not(aurora_android))]
#[tauri::command]
pub async fn yt_search(app: AppHandle, query: String, limit: Option<u32>, site: Option<String>) -> Result<Vec<SearchItem>, String> {
    let r = resolve(&app)?;
    let ytdlp = r.ytdlp.clone().ok_or_else(not_ready)?;
    let n = limit.unwrap_or(24).clamp(1, 60);
    search_site(&r, &ytdlp, &query, n, site.as_deref().unwrap_or("youtube")).await
}

#[cfg(not(aurora_android))]
/// Something the preview player can play: a direct https stream if the site
/// offers one, otherwise a 30-second clip saved to a temp file (SoundCloud's
/// HLS streams can't be played directly). Returns a URL or a local path.
#[tauri::command]
pub async fn yt_stream_url(app: AppHandle, id: String) -> Result<String, String> {
    let r = resolve(&app)?;
    let ytdlp = r.ytdlp.clone().ok_or_else(not_ready)?;
    let url = if id.starts_with("http") { id } else { format!("https://www.youtube.com/watch?v={id}") };

    let direct = command(&ytdlp)
        .args(common_args(&r))
        .args(["--no-playlist", "--no-warnings", "-f", "bestaudio[ext=m4a][protocol^=http]/bestaudio[protocol^=http]", "-g"])
        .arg(&url)
        .output();
    if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(40), direct).await {
        if out.status.success() {
            if let Some(u) = String::from_utf8_lossy(&out.stdout).lines().find(|l| l.starts_with("http") && !l.contains(".m3u8")) {
                return Ok(u.trim().to_string());
            }
        }
    }

    // Fallback: cut a 30-second clip.
    let dir = crate::store::data_dir(&app)?.join("previews");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = crate::library::hash_hex(&url, 16);
    let target = dir.join(format!("{name}.mp3"));
    if target.is_file() {
        return Ok(target.to_string_lossy().into_owned());
    }
    // Keep the folder small: drop clips older than a day.
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).map_or(false, |a| a.as_secs() > 86_400);
            if old {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let clip = command(&ytdlp)
        .args(common_args(&r))
        .args(["--no-playlist", "--no-warnings", "-x", "--audio-format", "mp3", "--audio-quality", "5", "--download-sections", "*0-30", "--force-overwrites", "-o"])
        .arg(dir.join(format!("{name}.%(ext)s")))
        .arg(&url)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(90), clip)
        .await
        .map_err(|_| "The preview took too long to load.".to_string())?
        .map_err(|e| e.to_string())?;
    if !out.status.success() || !target.is_file() {
        return Err(error_from(&String::from_utf8_lossy(&out.stderr)));
    }
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(not(aurora_android))]
fn strip_topic(s: &str) -> String {
    s.trim().trim_end_matches(" - Topic").trim().to_string()
}

#[cfg(not(aurora_android))]
async fn flat_json(r: &crate::tools::Resolved, ytdlp: &Path, url: &str, timeout: u64) -> Result<FlatPlaylist, String> {
    let fut = command(ytdlp)
        .args(common_args(r))
        .args(["--flat-playlist", "-J", "--no-warnings"])
        .arg(url)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(timeout), fut)
        .await
        .map_err(|_| "YouTube took too long to answer.".to_string())?
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(error_from(&String::from_utf8_lossy(&out.stderr)));
    }
    let list: FlatPlaylist =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("Unexpected yt-dlp output: {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if list.entries.iter().all(Option::is_none) && stderr.contains("ERROR") {
        return Err(error_from(&stderr));
    }
    Ok(list)
}

#[cfg(not(aurora_android))]
fn to_album(p: FlatPlaylist, url: String) -> Option<AlbumResult> {
    let tracks: Vec<AlbumTrack> = p
        .entries
        .iter()
        .flatten()
        .filter_map(|e| {
            let title = e.title.clone().unwrap_or_default();
            if title == "[Deleted video]" || title == "[Private video]" {
                return None;
            }
            Some(AlbumTrack {
                id: e.id.clone()?,
                title,
                duration_ms: (e.duration.unwrap_or(0.0) * 1000.0) as u64,
                artist: None,
                preview: None,
            })
        })
        .collect();
    if tracks.is_empty() {
        return None;
    }
    let raw_title = p.title.unwrap_or_default();
    let title = raw_title.strip_prefix("Album - ").unwrap_or(&raw_title).trim().to_string();
    // Artist: the playlist owner, else the most common track channel.
    let artist = p
        .uploader
        .or(p.channel)
        .or(p.playlist_uploader)
        .map(|a| strip_topic(&a))
        .filter(|a| !a.is_empty())
        .or_else(|| {
            let mut counts: HashMap<String, usize> = HashMap::new();
            for e in p.entries.iter().flatten() {
                if let Some(c) = e.channel.as_ref().or(e.uploader.as_ref()) {
                    *counts.entry(strip_topic(c)).or_default() += 1;
                }
            }
            counts.into_iter().max_by_key(|(_, n)| *n).map(|(a, _)| a)
        })
        .unwrap_or_else(|| "Unknown artist".into());
    // Playlist thumbnails are often YouTube's grey "…" placeholder. Use real
    // album art (googleusercontent) if offered, else the first track's frame,
    // which for YouTube Music "art tracks" is the album cover.
    let thumb = p
        .thumbnails
        .iter()
        .filter_map(|t| t.url.as_ref().map(|u| (u, t.width.unwrap_or(0) * t.height.unwrap_or(0))))
        .filter(|(u, _)| u.contains("googleusercontent.com") || u.contains("ggpht.com"))
        .max_by_key(|(_, a)| *a)
        .map(|(u, _)| u.clone())
        .or_else(|| tracks.first().map(|t| format!("https://i.ytimg.com/vi/{}/maxresdefault.jpg", t.id)));
    Some(AlbumResult {
        id: p.id.unwrap_or_else(|| url.clone()),
        url,
        title,
        artist,
        thumb,
        year: p.release_year,
        tracks,
    })
}

#[cfg(not(aurora_android))]
/// Finds albums on YouTube Music, then looks up each one's track list.
#[tauri::command]
pub async fn yt_search_albums(app: AppHandle, query: String) -> Result<Vec<AlbumResult>, String> {
    let r = resolve(&app)?;
    let ytdlp = r.ytdlp.clone().ok_or_else(not_ready)?;
    let q = url::form_urlencoded::byte_serialize(query.trim().as_bytes()).collect::<String>();

    // 1) YouTube Music's album section. 2) Fallback: YouTube playlist search.
    let mut urls: Vec<String> = Vec::new();
    let mut first_err = None;
    for search in [
        format!("https://music.youtube.com/search?q={q}#albums"),
        format!("https://www.youtube.com/results?search_query={q}&sp=EgIQAw%3D%3D"),
    ] {
        match flat_json(&r, &ytdlp, &search, 40).await {
            Ok(list) => {
                urls = list
                    .entries
                    .into_iter()
                    .flatten()
                    .filter_map(|e| {
                        e.url.or_else(|| e.id.map(|id| format!("https://www.youtube.com/playlist?list={id}")))
                    })
                    .take(8)
                    .collect();
                if !urls.is_empty() {
                    break;
                }
            }
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }
    if urls.is_empty() {
        return match first_err {
            Some(e) => Err(e),
            None => Ok(vec![]),
        };
    }

    // Resolve all candidates in parallel, keeping search order.
    let mut set = tokio::task::JoinSet::new();
    for (i, url) in urls.into_iter().enumerate() {
        let (r, ytdlp) = (r.clone(), ytdlp.clone());
        set.spawn(async move {
            let res = flat_json(&r, &ytdlp, &url, 45).await.ok().and_then(|p| to_album(p, url));
            (i, res)
        });
    }
    let mut found: Vec<(usize, AlbumResult)> = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok((i, Some(a))) = res {
            found.push((i, a));
        }
    }
    found.sort_by_key(|(i, _)| *i);
    // Drop duplicates (same album found twice).
    let mut seen = std::collections::HashSet::new();
    Ok(found
        .into_iter()
        .map(|(_, a)| a)
        .filter(|a| seen.insert(a.id.clone()))
        .collect())
}

/// Windows-safe file/folder name.
pub fn safe_name(s: &str, max: usize) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed: String = cleaned.trim().trim_end_matches(['.', ' ']).chars().take(max).collect();
    let t = trimmed.trim().trim_end_matches(['.', ' ']).to_string();
    if t.is_empty() {
        "Untitled".into()
    } else {
        t
    }
}

pub(crate) async fn cover_bytes(downloads: &Downloads, url: &str) -> Option<Vec<u8>> {
    if let Some(b) = downloads.covers.lock().unwrap().get(url) {
        return Some(b.clone());
    }
    // maxresdefault doesn't exist for every video; fall back to smaller frames.
    let mut candidates = vec![url.to_string()];
    if url.contains("/maxresdefault.jpg") {
        for alt in ["hq720.jpg", "sddefault.jpg", "mqdefault.jpg"] {
            candidates.push(url.replace("maxresdefault.jpg", alt));
        }
    }
    let mut bytes = None;
    for c in &candidates {
        if let Ok(r) = reqwest::get(c).await.and_then(|r| r.error_for_status()) {
            if let Ok(b) = r.bytes().await {
                bytes = Some(b);
                break;
            }
        }
    }
    let img = image::load_from_memory(&bytes?).ok()?;
    let side = img.width().min(img.height());
    let sq = img
        .crop_imm((img.width() - side) / 2, (img.height() - side) / 2, side, side)
        .resize(800, 800, image::imageops::FilterType::Lanczos3)
        .to_rgb8();
    let mut out = std::io::Cursor::new(Vec::new());
    sq.write_to(&mut out, image::ImageFormat::Jpeg).ok()?;
    let v = out.into_inner();
    downloads.covers.lock().unwrap().insert(url.to_string(), v.clone());
    Some(v)
}

/// Writes tags (and cover) into a downloaded song (MP3, Opus or M4A).
pub(crate) fn write_tags(path: &Path, m: &TagMeta, cover: Option<Vec<u8>>) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::prelude::*;
    use lofty::tag::Tag;

    // M4A: tag editing goes wrong on fragmented files and 64-bit offset tables
    // (the song then plays silence), so put those in the ordinary layout first.
    crate::mp4fix::fix_file(path)?;
    let mut file = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    if file.primary_tag().is_none() {
        let tt = file.primary_tag_type();
        file.insert_tag(Tag::new(tt));
    }
    let tag = file.primary_tag_mut().unwrap();
    tag.set_title(m.title.clone());
    tag.set_artist(m.artist.clone());
    match &m.album {
        Some(album) => {
            tag.set_album(album.clone());
            tag.insert_text(ItemKey::AlbumArtist, m.album_artist.clone().unwrap_or_else(|| m.artist.clone()));
            if let Some(n) = m.track_no {
                tag.set_track(n);
            }
            if let Some(n) = m.track_total {
                tag.set_track_total(n);
            }
        }
        None => {
            // Standalone song: no album, so it lives in Library → Songs.
            for k in [ItemKey::AlbumTitle, ItemKey::AlbumArtist, ItemKey::TrackNumber, ItemKey::TrackTotal] {
                tag.remove_key(&k);
            }
        }
    }
    if let Some(y) = m.year {
        tag.insert_text(ItemKey::Year, y.to_string());
    }
    if let Some(bytes) = cover {
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(Picture::new_unchecked(PictureType::CoverFront, Some(MimeType::Jpeg), None, bytes));
    }
    tag.save_to_path(path, WriteOptions::default()).map_err(|e| e.to_string())?;
    // Safety net: if saving left the audio index pointing at the wrong place, put it back.
    crate::mp4fix::fix_file(path)?;
    Ok(())
}

/// Singles are standalone songs: drop any album tag YouTube Music added.
pub(crate) fn strip_album(path: &Path) {
    use lofty::config::WriteOptions;
    use lofty::prelude::*;
    if let Ok(mut file) = lofty::read_from_path(path) {
        if let Some(tag) = file.primary_tag_mut() {
            if tag.album().is_some() {
                tag.remove_key(&ItemKey::AlbumTitle);
                tag.remove_key(&ItemKey::AlbumArtist);
                tag.remove_key(&ItemKey::TrackNumber);
                tag.remove_key(&ItemKey::TrackTotal);
                let _ = tag.save_to_path(path, WriteOptions::default());
                let _ = crate::mp4fix::fix_file(path);
            }
        }
    }
}

/* ------------- find the YouTube upload of a catalog song ------------- */

pub fn norm(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with(' ') {
            out.push(' ');
        }
    }
    out.trim().to_string()
}

/// Words that mean "not the studio recording" unless the catalog title has them too.
const BAD_WORDS: &[(&str, i32)] = &[
    ("live", 30), ("cover", 40), ("karaoke", 60), ("instrumental", 35), ("remix", 30),
    ("sped up", 50), ("slowed", 50), ("reverb", 30), ("nightcore", 60), ("8d", 40),
    ("reaction", 80), ("tutorial", 80), ("lesson", 60), ("acoustic", 20), ("piano", 20),
    ("edit", 10), ("mashup", 50), ("1 hour", 80), ("10 hours", 80), ("loop", 30),
];

/// Higher is better. Pure, so it's unit-tested.
pub fn score_candidate(
    target_artist: &str,
    target_title: &str,
    target_ms: u64,
    yt_title: &str,
    channel: &str,
    yt_ms: u64,
) -> i32 {
    let (ta, tt) = (norm(target_artist), norm(target_title));
    let (yt, ch) = (norm(yt_title), norm(channel));
    let mut score = 0;

    if target_ms > 0 && yt_ms > 0 {
        let diff = (target_ms as i64 - yt_ms as i64).abs();
        score += match diff {
            d if d <= 3_000 => 35,
            d if d <= 8_000 => 22,
            d if d <= 15_000 => 8,
            d if d <= 30_000 => -10,
            _ => -45,
        };
    }
    if channel.ends_with(" - Topic") {
        score += 25; // YouTube Music "art track": the official audio
    }
    let main_artist = ta.split(" feat ").next().unwrap_or(&ta).trim().to_string();
    if !main_artist.is_empty() && (ch.contains(&main_artist) || main_artist.contains(&ch) && !ch.is_empty()) {
        score += 15;
    }
    if channel.to_lowercase().contains("vevo") {
        score += 10;
    }
    if !tt.is_empty() && yt.contains(&tt) {
        score += 20;
    } else {
        // Partial credit for word overlap.
        let words: Vec<&str> = tt.split(' ').filter(|w| w.len() > 1).collect();
        if !words.is_empty() {
            let hit = words.iter().filter(|w| yt.split(' ').any(|y| y == **w)).count();
            score += (hit * 14 / words.len()) as i32 - 6;
        }
    }
    if !main_artist.is_empty() && yt.contains(&main_artist) {
        score += 8;
    }
    if yt.contains("official audio") || yt.contains("audio") {
        score += 4;
    }
    for (w, penalty) in BAD_WORDS {
        let in_yt = format!(" {yt} ").contains(&format!(" {w} "));
        let in_target = format!(" {tt} ").contains(&format!(" {w} "));
        if in_yt && !in_target {
            score -= penalty;
        }
    }
    score
}

#[cfg(not(aurora_android))]
/// Best matching uploads for a catalog song, best first (up to 3).
/// The caller tries them in order, so one broken upload doesn't fail the download.
#[tauri::command]
pub async fn yt_find_source(
    app: AppHandle,
    artist: String,
    title: String,
    duration_ms: u64,
    site: Option<String>,
) -> Result<Vec<String>, String> {
    let r = resolve(&app)?;
    let ytdlp = r.ytdlp.clone().ok_or_else(not_ready)?;
    let site = site.unwrap_or_else(|| "youtube".into());
    let items = search_site(&r, &ytdlp, &format!("{} - {}", artist.trim(), title.trim()), 8, &site).await?;
    let mut ranked: Vec<(i32, String)> = items
        .into_iter()
        .filter(|e| !e.live && !(e.preview_only && duration_ms > 40_000))
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

#[cfg(not(aurora_android))]
#[tauri::command]
pub async fn yt_download(
    app: AppHandle,
    downloads: State<'_, Downloads>,
    id: String,
    folder: String,
    quality: String,
    tags: Option<TagMeta>,
) -> Result<String, String> {
    let r = resolve(&app)?;
    let ytdlp = r.ytdlp.clone().ok_or_else(not_ready)?;
    if r.ffmpeg_dir.is_none() {
        return Err("FFmpeg is missing — open Settings → Download tools and press Install.".into());
    }
    // "original" keeps YouTube's own audio stream (usually ~130 kbps Opus) and
    // skips the MP3 conversion: about half the size and no re-encoding loss.
    let format = if quality == "original" { "best" } else { "mp3" };
    let q = match quality.as_str() {
        "320" => "320K",
        "192" => "192K",
        "128" => "128K",
        _ => "0", // VBR V0 (~245 kbps), best quality/size balance
    };

    // Albums go to "<folder>/Artist - Album/01 - Title.mp3" with a fixed name;
    // singles keep yt-dlp's "Artist - Title.mp3".
    let (out_dir, template, target): (PathBuf, String, Option<PathBuf>) = match &tags {
        Some(m) => {
            let (dir, stem) = match &m.album {
                Some(album) => {
                    let owner = m.album_artist.as_deref().unwrap_or(&m.artist);
                    (
                        Path::new(&folder).join(safe_name(&format!("{owner} - {album}"), 120)),
                        safe_name(&format!("{:02} - {}", m.track_no.unwrap_or(0), m.title), 140),
                    )
                }
                None => (PathBuf::from(&folder), safe_name(&format!("{} - {}", m.artist, m.title), 160)),
            };
            // Whichever format it was saved in before.
            let target = ["mp3", "opus", "m4a", "ogg", "webm"]
                .iter()
                .map(|e| dir.join(format!("{stem}.{e}")))
                .find(|p| p.is_file())
                .unwrap_or_else(|| dir.join(format!("{stem}.mp3")));
            (dir, format!("{}.%(ext)s", stem.replace('%', "%%")), Some(target))
        }
        None => (PathBuf::from(&folder), "%(artist,uploader)s - %(title)s.%(ext)s".into(), None),
    };

    // Already on disk (e.g. a re-run after a failure): just re-tag.
    if let (Some(m), Some(t)) = (&tags, &target) {
        if t.is_file() {
            let cover = match &m.cover_url {
                Some(u) => cover_bytes(&downloads, u).await,
                None => None,
            };
            let (p, m2) = (t.clone(), m.clone());
            tauri::async_runtime::spawn_blocking(move || write_tags(&p, &m2, cover))
                .await
                .map_err(|e| e.to_string())??;
            return Ok(t.to_string_lossy().into_owned());
        }
    }
    let out_dir_s = out_dir.to_string_lossy().into_owned();

    let tidy: &[&str] = if tags.is_some() {
        &[]
    } else {
        &[
            // Tidy tags: "Artist - Title (Official Video)" → artist + title.
            "--replace-in-metadata",
            "uploader,channel",
            r" - Topic$",
            "",
            "--parse-metadata",
            r"title:^(?P<artist>.+?)\s+[-–—]\s+(?P<title>.+)$",
            "--replace-in-metadata",
            "title",
            r"(?i)\s*[\(\[](official\s*(music\s*)?(video|audio|lyric video|visuali[sz]er)|lyrics?|audio|hd|4k|mv)[\)\]]",
            "",
        ]
    };

    downloads.canceled.lock().unwrap().retain(|x| x != &id);
    let target_url = if id.starts_with("http") { id.clone() } else { format!("https://www.youtube.com/watch?v={id}") };
    // YouTube sometimes answers 403 for one request and fine for the next
    // (each attempt fetches fresh stream URLs), so retry a few times.
    let mut attempt = 0u32;
    let path = loop {
    attempt += 1;
    let mut child = command(&ytdlp)
        .args(common_args(&r))
        .args(tidy)
        .args([
            "--no-playlist",
            "--extract-audio",
            "--audio-format",
            format,
            "--audio-quality",
            q,
            "--embed-metadata",
            "--embed-thumbnail",
            "--convert-thumbnails",
            "jpg",
            // Square album-art crop of the 16:9 thumbnail.
            "--ppa",
            "ThumbnailsConvertor+FFmpeg_o:-c:v mjpeg -vf crop=\"'if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'\"",
            "--retries",
            "5",
            "--fragment-retries",
            "5",
            "--extractor-retries",
            "3",
            "--windows-filenames",
            "--no-overwrites",
            "--newline",
            "--progress",
            "--no-simulate",
            "--progress-template",
            "download:@@P %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
            "--print",
            "after_move:@@F %(filepath)s",
            "-P",
            &out_dir_s,
            "-o",
            &template,
        ])
        .arg(&target_url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start yt-dlp: {e}"))?;

    if let Some(pid) = child.id() {
        downloads.running.lock().unwrap().insert(id.clone(), pid);
    }

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            s.push_str(&l);
            s.push('\n');
        }
        s
    });

    let mut path: Option<String> = None;
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(p) = line.strip_prefix("@@P ") {
            let mut parts = p.split('|');
            let percent = parts
                .next()
                .and_then(|s| s.trim().trim_end_matches('%').trim().parse::<f64>().ok())
                .unwrap_or(0.0);
            let _ = app.emit(
                "download://progress",
                Progress {
                    id: id.clone(),
                    percent,
                    speed: parts.next().unwrap_or("").trim().to_string(),
                    eta: parts.next().unwrap_or("").trim().to_string(),
                },
            );
        } else if let Some(p) = line.strip_prefix("@@F ") {
            path = Some(p.trim().to_string());
        }
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = err_task.await.unwrap_or_default();
    downloads.running.lock().unwrap().remove(&id);

    let was_canceled = {
        let mut c = downloads.canceled.lock().unwrap();
        let hit = c.contains(&id);
        c.retain(|x| x != &id);
        hit
    };
    if was_canceled {
        return Err("canceled".into());
    }
    let result: Result<String, String> = if !status.success() {
        Err(stderr.clone())
    } else {
        match path {
            Some(p) => Ok(p),
            // --no-overwrites: the file already existed, so yt-dlp skipped it.
            None if stderr.contains("already been downloaded") => return Err("Already downloaded to this folder.".into()),
            None => Err(stderr.clone()),
        }
    };
    match result {
        Ok(p) => break p,
        Err(raw) if attempt < DOWNLOAD_ATTEMPTS && is_transient(&raw) => {
            let _ = app.emit("download://retry", RetryInfo { id: id.clone(), attempt: attempt + 1, of: DOWNLOAD_ATTEMPTS });
            tokio::time::sleep(Duration::from_secs(2 * attempt as u64 + 1)).await;
            let canceled = {
                let mut c = downloads.canceled.lock().unwrap();
                let hit = c.contains(&id);
                c.retain(|x| x != &id);
                hit
            };
            if canceled {
                return Err("canceled".into());
            }
        }
        Err(raw) => return Err(error_from(&raw)),
    }
    };

    match tags {
        Some(m) => {
            let cover = match &m.cover_url {
                Some(u) => cover_bytes(&downloads, u).await,
                None => None,
            };
            let p = PathBuf::from(&path);
            tauri::async_runtime::spawn_blocking(move || write_tags(&p, &m, cover))
                .await
                .map_err(|e| e.to_string())??;
        }
        None => {
            let p = PathBuf::from(&path);
            let _ = tauri::async_runtime::spawn_blocking(move || strip_album(&p)).await;
        }
    }
    Ok(path)
}

#[cfg(not(aurora_android))]
#[tauri::command]
pub fn yt_cancel(app: AppHandle, id: String) -> Result<(), String> {
    let downloads = app.state::<Downloads>();
    let pid = downloads.running.lock().unwrap().get(&id).copied();
    downloads.canceled.lock().unwrap().push(id.clone());
    if let Some(pid) = pid {
        // Kill yt-dlp *and* its ffmpeg child.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000)
                .status();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lofty::prelude::*;

    /// Needs a real MP3 at $AURORA_TEST_MP3 (skipped otherwise).
    #[test]
    fn album_and_single_tagging() {
        let Ok(src) = std::env::var("AURORA_TEST_MP3") else { return };
        let dir = std::env::temp_dir().join(format!("aurora-tag-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.mp3");
        let b = dir.join("b.mp3");
        std::fs::copy(&src, &a).unwrap();
        std::fs::copy(&src, &b).unwrap();

        let img = image::RgbImage::from_pixel(64, 64, image::Rgb([200, 40, 90]));
        let mut jpg = std::io::Cursor::new(Vec::new());
        img.write_to(&mut jpg, image::ImageFormat::Jpeg).unwrap();
        let meta = TagMeta {
            album: Some("Discovery".into()),
            album_artist: None,
            artist: "Daft Punk".into(),
            title: "One More Time".into(),
            track_no: Some(1),
            track_total: Some(14),
            year: Some(2001),
            cover_url: None,
        };
        write_tags(&a, &meta, Some(jpg.into_inner())).unwrap();
        let f = lofty::read_from_path(&a).unwrap();
        let t = f.primary_tag().unwrap();
        assert_eq!(t.album().as_deref(), Some("Discovery"));
        assert_eq!(t.title().as_deref(), Some("One More Time"));
        assert_eq!(t.get_string(&ItemKey::AlbumArtist), Some("Daft Punk"));
        assert_eq!(t.track(), Some(1));
        assert_eq!(t.pictures().len(), 1);

        strip_album(&b);
        let f = lofty::read_from_path(&b).unwrap();
        assert!(f.primary_tag().unwrap().album().is_none());
        assert_eq!(f.primary_tag().unwrap().title().as_deref(), Some("Raw"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn picks_the_studio_recording() {
        let (a, t, ms) = ("Daft Punk", "One More Time", 320_000);
        let topic = score_candidate(a, t, ms, "One More Time", "Daft Punk - Topic", 320_000);
        let video = score_candidate(a, t, ms, "Daft Punk - One More Time (Official Video)", "Daft Punk", 324_000);
        let live = score_candidate(a, t, ms, "Daft Punk - One More Time (Live 2007)", "Daft Punk", 360_000);
        let cover = score_candidate(a, t, ms, "One More Time - Daft Punk cover", "Some Guitarist", 300_000);
        let hour = score_candidate(a, t, ms, "Daft Punk One More Time 1 hour loop", "loops", 3_600_000);
        assert!(topic > video, "{topic} vs {video}");
        assert!(video > live && video > cover && video > hour);
        // A remix is fine when the catalog asked for the remix.
        let rmx = score_candidate(a, "One More Time (Remix)", 300_000, "One More Time (Remix)", "Daft Punk - Topic", 300_000);
        assert!(rmx > 50);
        // Polish letters survive normalisation.
        assert_eq!(norm("Dawid Podsiadło – Małomiasteczkowy"), "dawid podsiadło małomiasteczkowy");
    }

    #[cfg(not(aurora_android))]
    #[test]
    fn transient_errors() {
        assert!(is_transient("ERROR: unable to download video data: HTTP Error 403: Forbidden"));
        assert!(is_transient("ERROR: Read timed out."));
        assert!(!is_transient("ERROR: Video unavailable. This video is private"));
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_name("AC/DC: Back in Black?", 100), "AC_DC_ Back in Black_");
        assert_eq!(safe_name("  ...  ", 100), "Untitled");
        assert_eq!(safe_name("Album.", 100), "Album");
    }
}

#[cfg(test)]
mod m4a_file {
    /// AURORA_M4A_SAMPLE=path cargo test m4a_file -- --ignored
    #[test]
    #[ignore]
    fn tags_m4a() {
        use lofty::prelude::*;
        let p = std::path::PathBuf::from(std::env::var("AURORA_M4A_SAMPLE").unwrap());
        let jpg = {
            let img = image::RgbImage::from_pixel(64, 64, image::Rgb([200, 10, 10]));
            let mut v = std::io::Cursor::new(Vec::new());
            img.write_to(&mut v, image::ImageFormat::Jpeg).unwrap();
            v.into_inner()
        };
        let m = super::TagMeta { title: "Song".into(), artist: "Artist".into(), album: Some("Album".into()), album_artist: None, track_no: Some(2), track_total: Some(9), year: Some(2020), cover_url: None };
        super::write_tags(&p, &m, Some(jpg)).unwrap();
        let f = lofty::read_from_path(&p).unwrap();
        let t = f.primary_tag().unwrap();
        assert_eq!(t.title().as_deref(), Some("Song"));
        assert_eq!(t.album().as_deref(), Some("Album"));
        assert_eq!(t.track(), Some(2));
        assert_eq!(t.pictures().len(), 1);
        super::strip_album(&p);
        let f = lofty::read_from_path(&p).unwrap();
        assert!(f.primary_tag().unwrap().album().is_none());
        assert!(f.properties().duration().as_secs() >= 7);
    }
}
