//! Backup to a single .zip and restore it on any PC.
//!
//! Layout of the archive:
//!   manifest.json                     what's inside + original paths
//!   data/*.json                       profiles, settings, playlists, stats, download history
//!   data/playlist-covers/*, data/avatars/*
//!   music/<folder name>/<sub/path>.mp3   every song in the library
//!
//! Track ids are derived from file paths, so a restore to a different folder
//! changes them. Restore rewrites every old id / path in the JSON data to the
//! new ones, so playlists, stats and history keep pointing at the right songs.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::rt::AppHandle;
use tauri::{Emitter, Manager};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::images::KINDS;
use crate::library::{hash_hex, scan, LibraryIndex, LibraryState};
use crate::store::data_dir;

const FORMAT: u32 = 1;
/// Files in the data folder that are machine-specific and rebuilt on restore.
const SKIP_DATA: &[&str] = &["library.json"];  // previews/ and bin/ are never backed up either

#[derive(Serialize, Deserialize, Clone)]
struct FolderEntry {
    orig: String,
    zip: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct TrackEntry {
    id: String,
    orig: String,
    zip: String,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    app: String,
    format: u32,
    created: u64,
    include_music: bool,
    folders: Vec<FolderEntry>,
    tracks: Vec<TrackEntry>,
}

#[derive(Clone, Serialize)]
pub struct Progress {
    pub step: String,
    pub done: u64,
    pub total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    tracks: usize,
    bytes: u64,
    folders: usize,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    pub tracks: usize,
    pub skipped: usize,
    pub folders: Vec<String>,
    pub active_profile: Option<String>,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn safe_component(s: &str) -> String {
    let c: String = s
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let t = c.trim().trim_end_matches(['.', ' ']).to_string();
    if t.is_empty() { "Music".into() } else { t }
}

/// Zip paths always use "/".
fn rel_zip_path(rel: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(p) => parts.push(p.to_string_lossy().into_owned()),
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// Safe relative path from a zip name: rejects "..", roots and drive prefixes.
fn safe_rel(name: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in name.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') {
            return None;
        }
        out.push(part);
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/* ------------------------------- create ------------------------------- */

fn plan(index: &LibraryIndex) -> (Vec<FolderEntry>, Vec<(TrackEntry, u64)>) {
    let mut folders = Vec::new();
    let mut used = HashSet::new();
    for f in &index.folders {
        let base = Path::new(f)
            .file_name()
            .map(|n| safe_component(&n.to_string_lossy()))
            .unwrap_or_else(|| "Music".into());
        let mut name = base.clone();
        let mut n = 2;
        while !used.insert(name.to_lowercase()) {
            name = format!("{base} ({n})");
            n += 1;
        }
        folders.push(FolderEntry { orig: f.clone(), zip: name });
    }
    let mut tracks = Vec::new();
    for t in &index.tracks {
        let p = Path::new(&t.path);
        // Prefer the deepest folder that contains the file.
        let best = folders
            .iter()
            .filter_map(|f| p.strip_prefix(&f.orig).ok().map(|rel| (f, rel)))
            .max_by_key(|(f, _)| f.orig.len());
        if let Some((f, rel)) = best {
            if let Some(r) = rel_zip_path(rel) {
                tracks.push((
                    TrackEntry { id: t.id.clone(), orig: t.path.clone(), zip: format!("music/{}/{}", f.zip, r) },
                    t.size,
                ));
            }
        }
    }
    (folders, tracks)
}

fn data_files(data: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(data) {
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if p.is_file() && name.ends_with(".json") && !SKIP_DATA.contains(&name.as_str()) {
                out.push((p, format!("data/{name}")));
            }
        }
    }
    for (_, folder, _) in KINDS {
        if let Ok(rd) = fs::read_dir(data.join(folder)) {
            for e in rd.flatten() {
                if e.path().is_file() {
                    let name = e.file_name().to_string_lossy().into_owned();
                    out.push((e.path(), format!("data/{folder}/{name}")));
                }
            }
        }
    }
    out
}

pub fn create(
    data: &Path,
    index: &LibraryIndex,
    dest: &Path,
    include_music: bool,
    progress: &dyn Fn(Progress),
) -> Result<(), String> {
    let tmp = dest.with_extension("zip.part");
    let file = File::create(&tmp).map_err(|e| format!("Couldn't create the backup file: {e}"))?;
    match create_to(data, index, file, include_music, progress) {
        Ok(()) => fs::rename(&tmp, dest).map_err(|e| e.to_string()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Writes the backup zip into any seekable output (a file, or on Android the
/// file the user picked in the system "save" screen).
pub fn create_to<W: Write + Seek>(
    data: &Path,
    index: &LibraryIndex,
    out: W,
    include_music: bool,
    progress: &dyn Fn(Progress),
) -> Result<(), String> {
    let (folders, mut tracks) = plan(index);
    if !include_music {
        tracks.clear();
    }
    let files = data_files(data);
    let total: u64 = tracks.iter().map(|(_, s)| *s).sum::<u64>()
        + files.iter().map(|(p, _)| fs::metadata(p).map(|m| m.len()).unwrap_or(0)).sum::<u64>();

    let manifest = Manifest {
        app: "aurora".into(),
        format: FORMAT,
        created: now_secs(),
        include_music,
        folders: if include_music { folders } else { vec![] },
        tracks: tracks.iter().map(|(t, _)| t.clone()).collect(),
    };

    let mut zip = zip::ZipWriter::new(BufWriter::with_capacity(1 << 20, out));
    let deflate = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    let result = (|| -> Result<(), String> {
        zip.start_file("manifest.json", deflate).map_err(|e| e.to_string())?;
        zip.write_all(&serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;

        let mut done = 0u64;
        let mut copy = |zip: &mut zip::ZipWriter<BufWriter<W>>, src: &Path, name: &str, step: &str| -> Result<(), String> {
            let size = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
            // Audio and JPEGs are already compressed; storing them is much faster.
            let opts = if name.ends_with(".json") { deflate } else { stored }.large_file(size >= u32::MAX as u64);
            let mut f = BufReader::new(File::open(src).map_err(|e| format!("{}: {e}", src.display()))?);
            zip.start_file(name, opts).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, zip).map_err(|e| e.to_string())?;
            done += size;
            progress(Progress { step: step.into(), done, total });
            Ok(())
        };

        for (src, name) in &files {
            copy(&mut zip, src, name, "Saving your data")?;
        }
        for (t, _) in &tracks {
            let src = PathBuf::from(&t.orig);
            if src.is_file() {
                copy(&mut zip, &src, &t.zip, "Copying music")?;
            }
        }
        Ok(())
    })();

    result.and_then(|_| {
        zip.finish()
            .map_err(|e| e.to_string())?
            .flush()
            .map_err(|e| e.to_string())
    })
}

/* ------------------------------- restore ------------------------------ */

/// Replaces old track ids and old paths anywhere in a JSON document
/// (string values and object keys).
pub(crate) fn remap(v: &mut Value, map: &HashMap<String, String>) {
    match v {
        Value::String(s) => {
            if let Some(n) = map.get(s.as_str()) {
                *s = n.clone();
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| remap(x, map)),
        Value::Object(o) => {
            let entries: Vec<(String, Value)> = std::mem::take(o).into_iter().collect();
            for (k, mut val) in entries {
                remap(&mut val, map);
                let key = map.get(&k).cloned().unwrap_or(k);
                // Merge numbers if two old keys collapse into one (rare).
                match (o.get_mut(&key), &val) {
                    (Some(Value::Number(a)), Value::Number(b)) => {
                        let sum = a.as_f64().unwrap_or(0.0) + b.as_f64().unwrap_or(0.0);
                        *o.get_mut(&key).unwrap() = serde_json::json!(sum);
                    }
                    _ => {
                        o.insert(key, val);
                    }
                }
            }
        }
        _ => {}
    }
}

pub(crate) fn read_json(p: &Path) -> Option<Value> {
    fs::read(p).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

pub(crate) fn write_json(p: &Path, v: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(v).map_err(|e| e.to_string())?;
    crate::store::write_atomic(&p.to_path_buf(), &bytes)
}

/// profiles.json: { active, list: [{ id, ... }] } — merge by id.
fn merge_profiles(existing: Option<Value>, incoming: Value) -> Value {
    let mut out = existing.unwrap_or_else(|| serde_json::json!({ "list": [] }));
    let inc_list = incoming.get("list").and_then(|l| l.as_array()).cloned().unwrap_or_default();
    let list = out
        .as_object_mut()
        .map(|o| o.entry("list").or_insert_with(|| Value::Array(vec![])));
    if let Some(Value::Array(list)) = list {
        for p in inc_list {
            let id = p.get("id").cloned();
            if let Some(pos) = list.iter().position(|x| x.get("id") == id.as_ref()) {
                list[pos] = p;
            } else {
                list.push(p);
            }
        }
    }
    if let (Some(o), Some(active)) = (out.as_object_mut(), incoming.get("active")) {
        o.insert("active".into(), active.clone());
    }
    out
}

pub fn restore(
    data: &Path,
    zip_path: &Path,
    music_dest: &Path,
    progress: &dyn Fn(Progress),
) -> Result<RestoreSummary, String> {
    let file = File::open(zip_path).map_err(|e| format!("Couldn't open the backup: {e}"))?;
    restore_from(data, file, music_dest, progress)
}

/// Restores from any seekable input (a file, or on Android the file the user picked).
pub fn restore_from<R: Read + Seek>(
    data: &Path,
    input: R,
    music_dest: &Path,
    progress: &dyn Fn(Progress),
) -> Result<RestoreSummary, String> {
    let mut zip = zip::ZipArchive::new(BufReader::new(input)).map_err(|_| "That file isn't a valid zip.".to_string())?;

    let manifest: Manifest = {
        let mut m = zip
            .by_name("manifest.json")
            .map_err(|_| "This zip isn't an Aurora backup (manifest.json is missing).".to_string())?;
        let mut s = String::new();
        m.read_to_string(&mut s).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| format!("The backup's manifest is damaged: {e}"))?
    };
    if manifest.app != "aurora" {
        return Err("This zip isn't an Aurora backup.".into());
    }
    if manifest.format > FORMAT {
        return Err("This backup was made by a newer version of Aurora. Update Aurora first.".into());
    }

    // ---- 1. music ----
    let mut map: HashMap<String, String> = HashMap::new();
    let mut new_folders = Vec::new();
    for f in &manifest.folders {
        let rel = safe_rel(&f.zip).ok_or("The backup contains an unsafe path.")?;
        let root = music_dest.join(rel);
        let root_s = root.to_string_lossy().into_owned();
        map.insert(f.orig.clone(), root_s.clone());
        new_folders.push(root_s);
    }

    let indices: Vec<usize> = manifest.tracks.iter().filter_map(|t| zip.index_for_name(&t.zip)).collect();
    let mut total = 0u64;
    for i in indices {
        if let Ok(e) = zip.by_index_raw(i) {
            total += e.size();
        }
    }
    let mut done = 0u64;
    let (mut restored, mut skipped) = (0usize, 0usize);

    for t in &manifest.tracks {
        let Some(rel) = t.zip.strip_prefix("music/").and_then(safe_rel) else {
            skipped += 1;
            continue;
        };
        let dest = music_dest.join(rel);
        let new_path = dest.to_string_lossy().into_owned();
        // Must match how the library scanner builds ids.
        map.insert(t.id.clone(), hash_hex(&new_path, 16));
        map.insert(t.orig.clone(), new_path);

        let Ok(mut entry) = zip.by_name(&t.zip) else {
            skipped += 1;
            continue;
        };
        let size = entry.size();
        let same = fs::metadata(&dest).map(|m| m.len() == size).unwrap_or(false);
        if !same {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
            }
            let part = dest.with_extension("aurora-part");
            let mut out = BufWriter::new(File::create(&part).map_err(|e| format!("{}: {e}", dest.display()))?);
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            out.flush().map_err(|e| e.to_string())?;
            drop(out);
            fs::rename(&part, &dest).map_err(|e| e.to_string())?;
        }
        restored += 1;
        done += size;
        progress(Progress { step: "Restoring music".into(), done, total });
    }

    // ---- 2. data ----
    progress(Progress { step: "Restoring profiles and playlists".into(), done, total });
    let names: Vec<String> = zip.file_names().map(str::to_string).collect();
    let mut active_profile = None;
    for name in names {
        let Some(rel) = name.strip_prefix("data/").and_then(safe_rel) else { continue };
        let parts: Vec<String> = rel.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        let mut buf = Vec::new();
        zip.by_name(&name).map_err(|e| e.to_string())?.read_to_end(&mut buf).map_err(|e| e.to_string())?;

        match parts.as_slice() {
            // Images: data/<playlist-covers|avatars>/<file>
            [folder, file] if KINDS.iter().any(|(_, f, _)| f == folder) => {
                let dir = data.join(folder);
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                fs::write(dir.join(file), &buf).map_err(|e| e.to_string())?;
            }
            [file] if file.ends_with(".json") && !SKIP_DATA.contains(&file.as_str()) => {
                let Ok(mut v) = serde_json::from_slice::<Value>(&buf) else { continue };
                remap(&mut v, &map);
                let target = data.join(file);
                let merged = match file.as_str() {
                    "profiles.json" => {
                        active_profile = v.get("active").and_then(|a| a.as_str()).map(str::to_string);
                        merge_profiles(read_json(&target), v)
                    }
                    "downloaded.json" => {
                        let mut cur = read_json(&target).unwrap_or_else(|| serde_json::json!({}));
                        if let (Some(c), Some(n)) = (cur.as_object_mut(), v.as_object()) {
                            for (k, val) in n {
                                c.insert(k.clone(), val.clone());
                            }
                        }
                        cur
                    }
                    _ => v,
                };
                write_json(&target, &merged)?;
            }
            _ => {}
        }
    }

    Ok(RestoreSummary { tracks: restored, skipped, folders: new_folders, active_profile })
}

/* ---------------------------- tauri commands --------------------------- */

#[tauri::command]
pub fn backup_estimate(app: AppHandle) -> Result<Estimate, String> {
    let index = app.state::<LibraryState>().snapshot();
    let (folders, tracks) = plan(&index);
    Ok(Estimate { tracks: tracks.len(), bytes: tracks.iter().map(|(_, s)| s).sum(), folders: folders.len() })
}

#[tauri::command]
pub async fn backup_create(app: AppHandle, dest: String, include_music: bool) -> Result<(), String> {
    let data = data_dir(&app)?;
    let index = app.state::<LibraryState>().snapshot();
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        create(&data, &index, Path::new(&dest), include_music, &|p| {
            let _ = a.emit("backup://progress", p);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_restore(app: AppHandle, zip: String, music_dest: String) -> Result<RestoreSummary, String> {
    let data = data_dir(&app)?;
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&music_dest).map_err(|e| e.to_string())?;
        let summary = restore(&data, Path::new(&zip), Path::new(&music_dest), &|p| {
            let _ = a.emit("backup://progress", p);
        })?;
        finish_restore(&a, summary)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// After a restore: add the restored music folders to the library and scan.
fn finish_restore(a: &AppHandle, summary: RestoreSummary) -> Result<RestoreSummary, String> {
    let state = a.state::<LibraryState>();
    state.add_folders(a, &summary.folders)?;
    let _ = a.emit("backup://progress", Progress { step: "Scanning your library".into(), done: 0, total: 0 });
    scan(a, &state)?;
    Ok(summary)
}

/* ------------------------------- Android ------------------------------- */
// On a phone the "save as" and "open" screens hand Aurora a file descriptor
// (the Android side opens the file the user picked). Most are ordinary files
// that can be written in place; anything that can't seek (some cloud
// providers) goes through a temporary file in Aurora's cache first.

#[cfg(aurora_android)]
fn take_fd(fd: i32) -> Result<File, String> {
    use std::os::fd::FromRawFd;
    if fd < 0 {
        return Err("No file was chosen.".into());
    }
    // SAFETY: the Android side detached this descriptor for us; we own it now.
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(aurora_android)]
fn seekable(f: &mut File) -> bool {
    f.stream_position().is_ok()
}

#[cfg(aurora_android)]
#[tauri::command]
pub async fn backup_create_fd(app: AppHandle, fd: i32, include_music: bool) -> Result<(), String> {
    let data = data_dir(&app)?;
    let index = app.state::<LibraryState>().snapshot();
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = take_fd(fd)?;
        let report = |p| {
            let _ = a.emit("backup://progress", p);
        };
        if seekable(&mut out) {
            return create_to(&data, &index, out, include_music, &report);
        }
        let tmp = data.join("backup-out.zip.part");
        let result = File::create(&tmp)
            .map_err(|e| e.to_string())
            .and_then(|f| create_to(&data, &index, f, include_music, &report))
            .and_then(|_| {
                let mut f = File::open(&tmp).map_err(|e| e.to_string())?;
                std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
                out.flush().map_err(|e| e.to_string())
            });
        let _ = fs::remove_file(&tmp);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(aurora_android)]
#[tauri::command]
pub async fn backup_restore_fd(app: AppHandle, fd: i32, music_dest: String) -> Result<RestoreSummary, String> {
    let data = data_dir(&app)?;
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&music_dest).map_err(|e| e.to_string())?;
        let mut input = take_fd(fd)?;
        let report = |p| {
            let _ = a.emit("backup://progress", p);
        };
        let summary = if seekable(&mut input) {
            restore_from(&data, input, Path::new(&music_dest), &report)?
        } else {
            let tmp = data.join("backup-in.zip.part");
            let copied = File::create(&tmp)
                .map_err(|e| e.to_string())
                .and_then(|mut f| std::io::copy(&mut input, &mut f).map_err(|e| e.to_string()));
            let r = copied.and_then(|_| restore(&data, &tmp, Path::new(&music_dest), &report));
            let _ = fs::remove_file(&tmp);
            r?
        };
        finish_restore(&a, summary)
    })
    .await
    .map_err(|e| e.to_string())?
}

/* -------------------------------- tests -------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    /// A backup made on Windows (C:\ paths) restores on Linux / Android:
    /// files land under the chosen folder and every reference is remapped.
    #[test]
    fn windows_backup_restores_elsewhere() {
        use std::io::Write as _;
        let base = std::env::temp_dir().join(format!("aurora-win-{}", rand::random::<u32>()));
        let (data, dest) = (base.join("data"), base.join("Music"));
        fs::create_dir_all(&data).unwrap();
        let win_root = r"C:\Users\me\Music\Aurora";
        let win_song = r"C:\Users\me\Music\Aurora\Kanye West - Graduation\01 - Good Morning.m4a";
        let old_id = hash_hex(win_song, 16);
        let manifest = serde_json::json!({
            "app": "aurora", "format": FORMAT, "created": 0, "include_music": true,
            "folders": [{"orig": win_root, "zip": "Aurora"}],
            "tracks": [{"id": old_id, "orig": win_song, "zip": "music/Aurora/Kanye West - Graduation/01 - Good Morning.m4a"}]
        });
        let zip_path = base.join("backup.zip");
        {
            let mut z = zip::ZipWriter::new(File::create(&zip_path).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("manifest.json", o).unwrap();
            z.write_all(manifest.to_string().as_bytes()).unwrap();
            z.start_file("music/Aurora/Kanye West - Graduation/01 - Good Morning.m4a", o).unwrap();
            z.write_all(b"audio").unwrap();
            z.start_file("data/p-x-playlists.json", o).unwrap();
            z.write_all(serde_json::json!([{"id": "pl", "trackIds": [old_id]}]).to_string().as_bytes()).unwrap();
            z.start_file("data/p-x-settings.json", o).unwrap();
            z.write_all(serde_json::json!({"downloadFolder": win_root}).to_string().as_bytes()).unwrap();
            z.finish().unwrap();
        }
        let r = restore(&data, &zip_path, &dest, &|_| {}).unwrap();
        assert_eq!(r.tracks, 1);
        let new_song = dest.join("Aurora").join("Kanye West - Graduation").join("01 - Good Morning.m4a");
        assert_eq!(fs::read(&new_song).unwrap(), b"audio");
        assert_eq!(r.folders, vec![dest.join("Aurora").to_string_lossy().into_owned()]);
        let pl: Value = serde_json::from_slice(&fs::read(data.join("p-x-playlists.json")).unwrap()).unwrap();
        assert_eq!(pl[0]["trackIds"][0], hash_hex(&new_song.to_string_lossy(), 16));
        let st: Value = serde_json::from_slice(&fs::read(data.join("p-x-settings.json")).unwrap()).unwrap();
        assert_eq!(st["downloadFolder"], dest.join("Aurora").to_string_lossy().as_ref());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn round_trip_remaps_ids_and_paths() {
        let base = std::env::temp_dir().join(format!("aurora-test-{}", rand::random::<u32>()));
        let (old_data, new_data) = (base.join("old-data"), base.join("new-data"));
        let music = base.join("My Music");
        for d in [&old_data, &new_data, &music.join("Daft Punk - Discovery"), &old_data.join("avatars")] {
            fs::create_dir_all(d).unwrap();
        }
        let song = music.join("Daft Punk - Discovery").join("01 - One More Time.mp3");
        fs::write(&song, b"fake mp3 bytes").unwrap();
        let single = music.join("Artist - Single.mp3");
        fs::write(&single, b"single").unwrap();

        let ids: Vec<String> = [&song, &single].iter().map(|p| hash_hex(&p.to_string_lossy(), 16)).collect();
        let index: LibraryIndex = serde_json::from_value(serde_json::json!({
            "version": 2,
            "folders": [music.to_string_lossy()],
            "tracks": [
                {"id": ids[0], "path": song.to_string_lossy(), "title": "One More Time", "artist": "Daft Punk",
                 "album": "Discovery", "albumTagged": true, "durationMs": 1, "mtime": 0, "size": 14},
                {"id": ids[1], "path": single.to_string_lossy(), "title": "Single", "artist": "Artist",
                 "album": "My Music", "durationMs": 1, "mtime": 0, "size": 6}
            ]
        }))
        .unwrap();

        fs::write(old_data.join("profiles.json"), serde_json::json!({"active": "abc", "list": [{"id": "abc", "name": "Me", "avatar": "abc-1.jpg"}]}).to_string()).unwrap();
        fs::write(old_data.join("p-abc-playlists.json"), serde_json::json!([{"id": "pl", "name": "Mix", "trackIds": [ids[1], ids[0]]}]).to_string()).unwrap();
        fs::write(old_data.join("p-abc-stats.json"), serde_json::json!({"totalMs": 5000, "tracks": {ids[0].clone(): 5000}}).to_string()).unwrap();
        fs::write(old_data.join("p-abc-settings.json"), serde_json::json!({"downloadFolder": music.to_string_lossy()}).to_string()).unwrap();
        fs::write(old_data.join("downloaded.json"), serde_json::json!({"vid1": single.to_string_lossy()}).to_string()).unwrap();
        fs::write(old_data.join("library.json"), "{}").unwrap();
        fs::write(old_data.join("avatars").join("abc-1.jpg"), b"jpg").unwrap();

        let zip = base.join("backup.zip");
        create(&old_data, &index, &zip, true, &|_| {}).unwrap();

        // "New PC": the original music is gone.
        fs::remove_dir_all(&music).unwrap();
        let dest = base.join("Restored");
        let s = restore(&new_data, &zip, &dest, &|_| {}).unwrap();
        assert_eq!(s.tracks, 2);
        assert_eq!(s.active_profile.as_deref(), Some("abc"));

        let new_song = dest.join("My Music").join("Daft Punk - Discovery").join("01 - One More Time.mp3");
        let new_single = dest.join("My Music").join("Artist - Single.mp3");
        assert_eq!(fs::read(&new_song).unwrap(), b"fake mp3 bytes");
        assert_eq!(s.folders, vec![dest.join("My Music").to_string_lossy().into_owned()]);

        let nid0 = hash_hex(&new_song.to_string_lossy(), 16);
        let nid1 = hash_hex(&new_single.to_string_lossy(), 16);
        let pl: Value = read_json(&new_data.join("p-abc-playlists.json")).unwrap();
        assert_eq!(pl[0]["trackIds"], serde_json::json!([nid1, nid0]));
        let st: Value = read_json(&new_data.join("p-abc-stats.json")).unwrap();
        assert_eq!(st["tracks"][&nid0], serde_json::json!(5000));
        let set: Value = read_json(&new_data.join("p-abc-settings.json")).unwrap();
        assert_eq!(set["downloadFolder"], serde_json::json!(dest.join("My Music").to_string_lossy()));
        let dl: Value = read_json(&new_data.join("downloaded.json")).unwrap();
        assert_eq!(dl["vid1"], serde_json::json!(new_single.to_string_lossy()));
        assert!(new_data.join("avatars").join("abc-1.jpg").is_file());
        assert!(!new_data.join("library.json").exists());

        // Restoring twice is safe (files already there are kept).
        let again = restore(&new_data, &zip, &dest, &|_| {}).unwrap();
        assert_eq!(again.tracks, 2);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn rejects_unsafe_paths() {
        assert!(safe_rel("../evil").is_none());
        assert!(safe_rel("C:/Windows").is_none());
        assert_eq!(safe_rel("a/b.mp3"), Some(PathBuf::from("a").join("b.mp3")));
    }
}
