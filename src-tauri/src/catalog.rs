//! "Music only" search: results come from a real music catalog instead of
//! raw YouTube, so you only see songs and albums that actually exist, with
//! proper titles, artists and 1000px cover art. Downloads then pick the best
//! matching YouTube upload (see yt::yt_find_source).
//!
//! Deezer's public API is used first (no key needed); Apple's iTunes Search
//! API is the fallback if Deezer can't be reached.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::yt::{AlbumResult, AlbumTrack};

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTrack {
    /// "dz:123" or "it:123"
    id: String,
    title: String,
    artist: String,
    album: Option<String>,
    cover: Option<String>,
    duration_ms: u64,
    explicit: bool,
    year: Option<u32>,
    /// 30-second preview clip (Deezer MP3 / iTunes AAC), playable without downloading.
    preview: Option<String>,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Aurora/0.1 (desktop music player)")
        .timeout(Duration::from_secs(15))
        .build()
        .expect("http client")
}

async fn get_json(url: &str) -> Result<Value, String> {
    let v: Value = client()
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Music catalog unreachable: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Unexpected catalog answer: {e}"))?;
    // Deezer reports errors (e.g. rate limit) as 200 + {"error": {...}}.
    if let Some(err) = v.get("error") {
        return Err(format!(
            "Music catalog error: {}",
            err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown")
        ));
    }
    Ok(v)
}

fn enc(q: &str) -> String {
    url::form_urlencoded::byte_serialize(q.trim().as_bytes()).collect()
}

fn year_of(date: Option<&str>) -> Option<u32> {
    date.and_then(|d| d.get(..4)).and_then(|y| y.parse().ok())
}

/* -------------------------------- Deezer ------------------------------- */

#[derive(Deserialize, Default)]
#[serde(default)]
struct DzArtist {
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct DzAlbumRef {
    title: String,
    cover_xl: Option<String>,
    cover_big: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct DzTrack {
    id: u64,
    title: String,
    preview: Option<String>,
    duration: u64,
    explicit_lyrics: bool,
    artist: DzArtist,
    album: Option<DzAlbumRef>,
    readable: Option<bool>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct DzList<T> {
    data: Vec<T>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct DzAlbum {
    id: u64,
    title: String,
    cover_xl: Option<String>,
    cover_big: Option<String>,
    nb_tracks: u32,
    record_type: Option<String>,
    release_date: Option<String>,
    artist: DzArtist,
    tracks: Option<DzList<DzTrack>>,
}

fn dz_track(t: DzTrack) -> Option<CatalogTrack> {
    if t.readable == Some(false) || t.id == 0 || t.title.is_empty() {
        return None;
    }
    let album = t.album.as_ref();
    Some(CatalogTrack {
        id: format!("dz:{}", t.id),
        title: t.title,
        artist: t.artist.name,
        album: album.map(|a| a.title.clone()).filter(|a| !a.is_empty()),
        cover: album.and_then(|a| a.cover_xl.clone().or_else(|| a.cover_big.clone())),
        duration_ms: t.duration * 1000,
        explicit: t.explicit_lyrics,
        year: None,
        preview: t.preview.filter(|p| !p.is_empty()),
    })
}

fn parse_dz_tracks(v: Value) -> Vec<CatalogTrack> {
    serde_json::from_value::<DzList<DzTrack>>(v)
        .map(|l| l.data.into_iter().filter_map(dz_track).collect())
        .unwrap_or_default()
}

fn dz_album_result(a: DzAlbum, tracks: Vec<DzTrack>) -> Option<AlbumResult> {
    let album_artist = a.artist.name.clone();
    let tracks: Vec<AlbumTrack> = tracks
        .into_iter()
        .filter(|t| t.readable != Some(false) && t.id != 0)
        .map(|t| AlbumTrack {
            id: format!("dz:{}", t.id),
            artist: (!t.artist.name.is_empty() && t.artist.name != album_artist).then_some(t.artist.name),
            title: t.title,
            duration_ms: t.duration * 1000,
            preview: t.preview.filter(|p| !p.is_empty()),
        })
        .collect();
    if tracks.is_empty() {
        return None;
    }
    Some(AlbumResult {
        id: format!("dz:{}", a.id),
        url: format!("https://www.deezer.com/album/{}", a.id),
        title: a.title,
        artist: album_artist,
        thumb: a.cover_xl.or(a.cover_big),
        year: year_of(a.release_date.as_deref()),
        tracks,
    })
}

async fn deezer_tracks(q: &str) -> Result<Vec<CatalogTrack>, String> {
    let v = get_json(&format!("https://api.deezer.com/search/track?q={}&limit=30", enc(q))).await?;
    Ok(parse_dz_tracks(v))
}

async fn deezer_album_full(id: u64) -> Result<Option<AlbumResult>, String> {
    let v = get_json(&format!("https://api.deezer.com/album/{id}")).await?;
    let mut album: DzAlbum = serde_json::from_value(v).map_err(|e| e.to_string())?;
    let mut tracks = album.tracks.take().map(|l| l.data).unwrap_or_default();
    // Very long albums: the album object may not list every track.
    if (tracks.len() as u32) < album.nb_tracks {
        let all = get_json(&format!("https://api.deezer.com/album/{id}/tracks?limit=300")).await?;
        if let Ok(l) = serde_json::from_value::<DzList<DzTrack>>(all) {
            tracks = l.data;
        }
    }
    Ok(dz_album_result(album, tracks))
}

async fn deezer_albums(q: &str) -> Result<Vec<AlbumResult>, String> {
    let v = get_json(&format!("https://api.deezer.com/search/album?q={}&limit=12", enc(q))).await?;
    let list: DzList<DzAlbum> = serde_json::from_value(v).map_err(|e| e.to_string())?;
    // Albums and EPs first; singles are better found under Songs.
    let mut ids: Vec<(usize, u64)> = list
        .data
        .iter()
        .filter(|a| a.record_type.as_deref() != Some("single") || a.nb_tracks > 2)
        .map(|a| a.id)
        .take(8)
        .enumerate()
        .collect();
    let mut set = tokio::task::JoinSet::new();
    for (i, id) in ids.drain(..) {
        set.spawn(async move { (i, deezer_album_full(id).await) });
    }
    let mut found = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok((i, Ok(Some(a)))) = res {
            found.push((i, a));
        }
    }
    found.sort_by_key(|(i, _)| *i);
    Ok(found.into_iter().map(|(_, a)| a).collect())
}

/* -------------------------------- iTunes ------------------------------- */

fn big_art(url: Option<&str>) -> Option<String> {
    url.map(|u| u.replace("100x100bb", "1000x1000bb"))
}

fn parse_it_tracks(v: &Value) -> Vec<CatalogTrack> {
    v.get("results")
        .and_then(|r| r.as_array())
        .map(|a| {
            a.iter()
                .filter(|r| r.get("wrapperType").and_then(|w| w.as_str()) == Some("track"))
                .filter_map(|r| {
                    Some(CatalogTrack {
                        id: format!("it:{}", r.get("trackId")?.as_u64()?),
                        title: r.get("trackName")?.as_str()?.to_string(),
                        artist: r.get("artistName")?.as_str()?.to_string(),
                        album: r.get("collectionName").and_then(|c| c.as_str()).map(str::to_string),
                        cover: big_art(r.get("artworkUrl100").and_then(|c| c.as_str())),
                        duration_ms: r.get("trackTimeMillis").and_then(|d| d.as_u64()).unwrap_or(0),
                        explicit: r.get("trackExplicitness").and_then(|e| e.as_str()) == Some("explicit"),
                        year: year_of(r.get("releaseDate").and_then(|d| d.as_str())),
                        preview: r.get("previewUrl").and_then(|p| p.as_str()).map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn itunes_tracks(q: &str) -> Result<Vec<CatalogTrack>, String> {
    let v = get_json(&format!("https://itunes.apple.com/search?media=music&entity=song&limit=30&term={}", enc(q))).await?;
    Ok(parse_it_tracks(&v))
}

/// One search + one lookup for all albums' tracks (iTunes allows ~20 calls a minute).
async fn itunes_albums(q: &str) -> Result<Vec<AlbumResult>, String> {
    let v = get_json(&format!("https://itunes.apple.com/search?media=music&entity=album&limit=8&term={}", enc(q))).await?;
    let albums: Vec<&Value> = v.get("results").and_then(|r| r.as_array()).map(|a| a.iter().collect()).unwrap_or_default();
    let ids: Vec<String> = albums
        .iter()
        .filter_map(|a| a.get("collectionId").and_then(|i| i.as_u64()).map(|i| i.to_string()))
        .collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let lookup = get_json(&format!("https://itunes.apple.com/lookup?entity=song&limit=200&id={}", ids.join(","))).await?;
    let songs = parse_it_tracks(&lookup);
    let raw = lookup.get("results").and_then(|r| r.as_array()).cloned().unwrap_or_default();
    Ok(albums
        .iter()
        .filter_map(|a| {
            let cid = a.get("collectionId")?.as_u64()?;
            let album_artist = a.get("artistName")?.as_str()?.to_string();
            // Tracks of this album, in disc/track order.
            let mut mine: Vec<(u64, u64, &CatalogTrack)> = raw
                .iter()
                .filter(|r| r.get("wrapperType").and_then(|w| w.as_str()) == Some("track"))
                .filter(|r| r.get("collectionId").and_then(|c| c.as_u64()) == Some(cid))
                .filter_map(|r| {
                    let id = format!("it:{}", r.get("trackId")?.as_u64()?);
                    let t = songs.iter().find(|s| s.id == id)?;
                    let disc = r.get("discNumber").and_then(|d| d.as_u64()).unwrap_or(1);
                    let no = r.get("trackNumber").and_then(|d| d.as_u64()).unwrap_or(0);
                    Some((disc, no, t))
                })
                .collect();
            mine.sort_by_key(|(d, n, _)| (*d, *n));
            let tracks: Vec<AlbumTrack> = mine
                .into_iter()
                .map(|(_, _, t)| AlbumTrack {
                    id: t.id.clone(),
                    title: t.title.clone(),
                    duration_ms: t.duration_ms,
                    artist: (t.artist != album_artist).then(|| t.artist.clone()),
                    preview: t.preview.clone(),
                })
                .collect();
            if tracks.is_empty() {
                return None;
            }
            Some(AlbumResult {
                id: format!("it:{cid}"),
                url: a.get("collectionViewUrl").and_then(|u| u.as_str()).unwrap_or("").to_string(),
                title: a.get("collectionName")?.as_str()?.to_string(),
                artist: album_artist,
                thumb: big_art(a.get("artworkUrl100").and_then(|c| c.as_str())),
                year: year_of(a.get("releaseDate").and_then(|d| d.as_str())),
                tracks,
            })
        })
        .collect())
}

/* ------------------------- matching Last.fm items ------------------------ */

/// "One More Time (Radio Edit) [Remastered 2011]" → "one more time radio edit"
pub fn core_title(s: &str) -> String {
    let lower = s.to_lowercase();
    let cut = ["remaster", "feat.", "feat ", "ft.", "(with ", " - "]
        .iter()
        .filter_map(|w| lower.find(w))
        .min()
        .unwrap_or(lower.len());
    let base = lower[..cut].trim_end_matches([' ', '(', '[', '-']);
    crate::yt::norm(base)
}

fn same_song(a_artist: &str, a_title: &str, b_artist: &str, b_title: &str) -> bool {
    let (ta, tb) = (core_title(a_title), core_title(b_title));
    let (aa, ab) = (crate::yt::norm(a_artist), crate::yt::norm(b_artist));
    !ta.is_empty() && ta == tb && (aa == ab || aa.contains(&ab) || ab.contains(&aa))
}

async fn match_one(artist: String, title: String) -> Option<CatalogTrack> {
    let strict = format!("artist:\"{}\" track:\"{}\"", artist.replace('"', ""), title.replace('"', ""));
    for q in [strict, format!("{artist} {title}")] {
        if let Ok(v) = get_json(&format!("https://api.deezer.com/search/track?q={}&limit=10", enc(&q))).await {
            if let Some(t) = parse_dz_tracks(v).into_iter().find(|t| same_song(&artist, &title, &t.artist, &t.title)) {
                return Some(t);
            }
        }
    }
    let v = get_json(&format!(
        "https://itunes.apple.com/search?media=music&entity=song&limit=10&term={}",
        enc(&format!("{artist} {title}"))
    ))
    .await
    .ok()?;
    parse_it_tracks(&v).into_iter().find(|t| same_song(&artist, &title, &t.artist, &t.title))
}

#[derive(Deserialize)]
pub struct SongRef {
    artist: String,
    title: String,
}

/// Looks up many (artist, title) pairs; keeps the input order. `None` = not in the catalog.
#[tauri::command]
pub async fn catalog_match_tracks(items: Vec<SongRef>) -> Result<Vec<Option<CatalogTrack>>, String> {
    let items: Vec<SongRef> = items.into_iter().take(60).collect();
    let mut out: Vec<Option<CatalogTrack>> = vec![None; items.len()];
    // Small batches keep us well inside Deezer's 50 requests / 5 s.
    for (chunk_i, chunk) in items.chunks(6).enumerate() {
        let mut set = tokio::task::JoinSet::new();
        for (j, s) in chunk.iter().enumerate() {
            let (a, t) = (s.artist.clone(), s.title.clone());
            set.spawn(async move { (j, match_one(a, t).await) });
        }
        while let Some(Ok((j, r))) = set.join_next().await {
            out[chunk_i * 6 + j] = r;
        }
    }
    Ok(out)
}

/// Finds a specific album (e.g. from Last.fm top albums) with its track list.
#[tauri::command]
pub async fn catalog_match_album(artist: String, album: String) -> Result<Option<AlbumResult>, String> {
    let q = format!("artist:\"{}\" album:\"{}\"", artist.replace('"', ""), album.replace('"', ""));
    let v = get_json(&format!("https://api.deezer.com/search/album?q={}&limit=8", enc(&q))).await?;
    let list: DzList<DzAlbum> = serde_json::from_value(v).map_err(|e| e.to_string())?;
    let want = core_title(&album);
    let pick = list
        .data
        .iter()
        .find(|a| core_title(&a.title) == want)
        .or_else(|| list.data.first())
        .map(|a| a.id);
    match pick {
        Some(id) => deezer_album_full(id).await,
        None => Ok(None),
    }
}

/// Last.fm stopped serving artist photos, so pictures come from Deezer.
#[tauri::command]
pub async fn catalog_artist_picture(name: String) -> Result<Option<String>, String> {
    let v = get_json(&format!("https://api.deezer.com/search/artist?q={}&limit=5", enc(&name))).await?;
    let want = crate::yt::norm(&name);
    let data = v.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
    let best = data
        .iter()
        .find(|a| a.get("name").and_then(|n| n.as_str()).map(crate::yt::norm).as_deref() == Some(want.as_str()))
        .or_else(|| data.first());
    Ok(best
        .and_then(|a| a.get("picture_xl").or_else(|| a.get("picture_big")))
        .and_then(|p| p.as_str())
        .map(str::to_string))
}

/* ------------------------------- commands ------------------------------ */

#[tauri::command]
pub async fn catalog_search_tracks(query: String) -> Result<Vec<CatalogTrack>, String> {
    match deezer_tracks(&query).await {
        Ok(v) if !v.is_empty() => Ok(v),
        Ok(_) => Ok(itunes_tracks(&query).await.unwrap_or_default()),
        Err(dz) => itunes_tracks(&query).await.map_err(|it| format!("{dz} / {it}")),
    }
}

#[tauri::command]
pub async fn catalog_search_albums(query: String) -> Result<Vec<AlbumResult>, String> {
    match deezer_albums(&query).await {
        Ok(v) if !v.is_empty() => Ok(v),
        Ok(_) => Ok(itunes_albums(&query).await.unwrap_or_default()),
        Err(dz) => itunes_albums(&query).await.map_err(|it| format!("{dz} / {it}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_deezer_tracks() {
        let v = json!({ "data": [
            { "id": 3135556, "readable": true, "title": "Harder, Better, Faster, Stronger", "title_short": "Harder, Better, Faster, Stronger",
              "duration": 224, "rank": 956167, "explicit_lyrics": false, "preview": "https://cdnt-preview.dzcdn.net/x.mp3",
              "artist": { "id": 27, "name": "Daft Punk", "picture_xl": "…" },
              "album": { "id": 302127, "title": "Discovery", "cover_xl": "https://e-cdns-images.dzcdn.net/images/cover/x/1000x1000-000000-80-0-0.jpg" },
              "type": "track" },
            { "id": 1, "readable": false, "title": "Unavailable", "duration": 10, "artist": { "name": "X" } }
        ], "total": 2 });
        let t = parse_dz_tracks(v);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].id, "dz:3135556");
        assert_eq!(t[0].artist, "Daft Punk");
        assert_eq!(t[0].album.as_deref(), Some("Discovery"));
        assert_eq!(t[0].duration_ms, 224_000);
        assert!(t[0].cover.as_ref().unwrap().contains("1000x1000"));
        assert!(t[0].preview.as_ref().unwrap().ends_with(".mp3"));
    }

    #[test]
    fn parses_deezer_album_with_compilation_artists() {
        let a: DzAlbum = serde_json::from_value(json!({
            "id": 302127, "title": "Discovery", "cover_xl": "c", "nb_tracks": 2, "release_date": "2001-03-07",
            "record_type": "album", "artist": { "name": "Daft Punk" },
            "tracks": { "data": [
                { "id": 1, "title": "One More Time", "duration": 320, "artist": { "name": "Daft Punk" } },
                { "id": 2, "title": "Guest Song", "duration": 200, "artist": { "name": "Romanthony" } }
            ] }
        }))
        .unwrap();
        let mut a = a;
        let tracks = a.tracks.take().unwrap().data;
        let r = dz_album_result(a, tracks).unwrap();
        assert_eq!(r.year, Some(2001));
        assert_eq!(r.tracks.len(), 2);
        assert_eq!(r.tracks[0].artist, None);
        assert_eq!(r.tracks[1].artist.as_deref(), Some("Romanthony"));
    }

    #[test]
    fn matches_titles_loosely() {
        assert!(same_song("Daft Punk", "One More Time", "Daft Punk", "One More Time (Radio Edit)") == false);
        assert!(same_song("Daft Punk", "Get Lucky (feat. Pharrell Williams)", "Daft Punk", "Get Lucky"));
        assert!(same_song("The Beatles", "Let It Be - Remastered 2009", "Beatles", "Let It Be"));
        assert!(!same_song("Daft Punk", "Get Lucky", "Some Cover Band", "Get Lucky"));
        assert!(same_song("The Beatles", "Let It Be - 2009 Remaster", "The Beatles", "Let It Be"));
    }

    #[test]
    fn parses_itunes() {
        let v = json!({ "resultCount": 2, "results": [
            { "wrapperType": "collection", "collectionId": 9 },
            { "wrapperType": "track", "trackId": 697195787, "artistName": "Daft Punk", "collectionName": "Discovery",
              "trackName": "One More Time", "artworkUrl100": "https://is1-ssl.mzstatic.com/a/100x100bb.jpg",
              "trackTimeMillis": 320357, "releaseDate": "2001-03-07T08:00:00Z", "trackExplicitness": "notExplicit" }
        ]});
        let t = parse_it_tracks(&v);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].cover.as_deref(), Some("https://is1-ssl.mzstatic.com/a/1000x1000bb.jpg"));
        assert_eq!(t[0].year, Some(2001));
        assert_eq!(t[0].duration_ms, 320_357);
    }
}
