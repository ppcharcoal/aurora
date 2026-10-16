//! Linux: WebKitGTK plays <audio> through GStreamer, which can't read Tauri's
//! asset:// scheme ("The operation is not supported"). So on Linux songs are
//! served to the player over plain HTTP on 127.0.0.1 instead.
//!
//! - Only reachable from this computer (loopback), on a random port.
//! - Every URL carries a random secret, so other programs can't guess them.
//! - Only audio files (and cover pictures) inside folders Aurora may read (its library folders and
//!   preview cache, the same list as the asset scope) are served.
//! - Supports Range requests, so seeking works.

use std::path::{Path, PathBuf};

use crate::rt::AppHandle;
use tauri::{Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// "http://127.0.0.1:<port>/<secret>/" — the frontend appends the URL-encoded path.
pub struct MediaBase(pub Option<String>);

#[tauri::command]
pub fn media_base(state: tauri::State<'_, MediaBase>) -> Option<String> {
    state.0.clone()
}

/// Starts the server; returns its base URL.
pub fn start(app: &AppHandle) -> std::io::Result<String> {
    let std_listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    std_listener.set_nonblocking(true)?;
    let port = std_listener.local_addr()?.port();
    let secret: String = (0..16).map(|_| format!("{:02x}", rand::random::<u8>())).collect();
    let base = format!("http://127.0.0.1:{port}/{secret}/");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = TcpListener::from_std(std_listener) else { return };
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let (app, secret) = (app.clone(), secret.clone());
            tauri::async_runtime::spawn(async move {
                let allowed = |p: &Path, real: &Path| {
                    let scope = app.asset_protocol_scope();
                    // The scope lists folders as they were added; a symlinked folder only matches before resolving.
                    scope.is_allowed(p) || scope.is_allowed(real)
                };
                let _ = serve(stream, &secret, &allowed).await;
            });
        }
    });
    Ok(base)
}

const AUDIO: &[(&str, &str)] = &[
    ("mp3", "audio/mpeg"),
    ("m4a", "audio/mp4"),
    ("mp4", "audio/mp4"),
    ("aac", "audio/aac"),
    ("opus", "audio/ogg"),
    ("ogg", "audio/ogg"),
    ("oga", "audio/ogg"),
    ("flac", "audio/flac"),
    ("wav", "audio/wav"),
    ("webm", "audio/webm"),
    // Covers and pictures (the Electron build shows these from here too).
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("png", "image/png"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
    ("bmp", "image/bmp"),
];

fn content_type(p: &Path) -> Option<&'static str> {
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    AUDIO.iter().find(|(e, _)| *e == ext).map(|(_, t)| *t)
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// "bytes=a-b" / "bytes=a-" / "bytes=-n" → (start, end inclusive).
fn parse_range(h: &str, len: u64) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (len.saturating_sub(n), len - 1)
    } else {
        let s: u64 = a.parse().ok()?;
        let e = if b.is_empty() { len - 1 } else { b.parse::<u64>().ok()?.min(len - 1) };
        (s, e)
    };
    (start <= end && start < len).then_some((start, end))
}

/// The file a request asks for, if it may be served.
fn resolve(secret: &str, target: &str, allowed: &(dyn Fn(&Path, &Path) -> bool + Sync)) -> Option<PathBuf> {
    let rest = target.strip_prefix('/')?.strip_prefix(secret)?.strip_prefix('/')?;
    let rest = rest.split('?').next()?;
    let path = PathBuf::from(percent_decode(rest)?);
    if !path.is_absolute() || content_type(&path).is_none() || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    let real = path.canonicalize().ok()?;
    if !real.is_file() || !allowed(&path, &real) {
        return None;
    }
    Some(real)
}

async fn reply(stream: &mut TcpStream, status: &str, headers: &[(&str, String)]) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {status}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n");
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await
}

async fn serve(mut stream: TcpStream, secret: &str, allowed: &(dyn Fn(&Path, &Path) -> bool + Sync)) -> std::io::Result<()> {
    // Read the request head (up to 16 KB).
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 16 * 1024 {
            return reply(&mut stream, "431 Request Header Fields Too Large", &[]).await;
        }
    }
    let head = String::from_utf8_lossy(&buf).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or("/"));
    let range = lines
        .take_while(|l| !l.is_empty())
        .find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("range")).map(|(_, v)| v.trim().to_string()));

    if method == "OPTIONS" {
        return reply(
            &mut stream,
            "204 No Content",
            &[("Access-Control-Allow-Headers", "Range".into()), ("Access-Control-Allow-Methods", "GET, HEAD".into())],
        )
        .await;
    }
    if method != "GET" && method != "HEAD" {
        return reply(&mut stream, "405 Method Not Allowed", &[("Content-Length", "0".into())]).await;
    }
    let Some(path) = resolve(secret, target, allowed) else {
        return reply(&mut stream, "404 Not Found", &[("Content-Length", "0".into())]).await;
    };
    let mut file = tokio::fs::File::open(&path).await?;
    let len = file.metadata().await?.len();
    let kind = content_type(&path).unwrap_or("application/octet-stream").to_string();

    let (status, start, end) = match range.as_deref().map(|r| parse_range(r, len)) {
        Some(Some((s, e))) => ("206 Partial Content", s, e),
        Some(None) => {
            return reply(&mut stream, "416 Range Not Satisfiable", &[("Content-Range", format!("bytes */{len}")), ("Content-Length", "0".into())])
                .await
        }
        None => ("200 OK", 0, len.saturating_sub(1)),
    };
    let count = if len == 0 { 0 } else { end - start + 1 };
    let mut headers = vec![
        ("Content-Type", kind),
        ("Content-Length", count.to_string()),
        ("Accept-Ranges", "bytes".to_string()),
        ("Cache-Control", "no-store".to_string()),
    ];
    if status.starts_with("206") {
        headers.push(("Content-Range", format!("bytes {start}-{end}/{len}")));
    }
    reply(&mut stream, status, &headers).await?;
    if method == "HEAD" || count == 0 {
        return Ok(());
    }
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let mut body = file.take(count);
    tokio::io::copy(&mut body, &mut stream).await?;
    stream.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-500", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
    }

    /// What GStreamer does when playing and seeking: whole file, then byte ranges.
    #[test]
    fn serves_files_and_ranges() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let dir = std::env::temp_dir().join(format!("aurora-media-{}", rand::random::<u32>()));
            std::fs::create_dir_all(&dir).unwrap();
            let song = dir.join("Żyć – test.mp3");
            let bytes: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
            std::fs::write(&song, &bytes).unwrap();
            std::fs::write(dir.join("secret.txt"), b"nope").unwrap();

            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let root = dir.clone();
            tokio::spawn(async move {
                loop {
                    let (s, _) = listener.accept().await.unwrap();
                    let root = root.clone();
                    tokio::spawn(async move {
                        let allowed = |_: &Path, real: &Path| real.starts_with(&root);
                        let _ = serve(s, "tok", &allowed).await;
                    });
                }
            });
            let get = |target: String, range: Option<&'static str>| async move {
                let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                let extra = range.map(|r| format!("Range: {r}\r\n")).unwrap_or_default();
                s.write_all(format!("GET {target} HTTP/1.1\r\nHost: x\r\n{extra}\r\n").as_bytes()).await.unwrap();
                let mut out = Vec::new();
                s.read_to_end(&mut out).await.unwrap();
                let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
                (String::from_utf8_lossy(&out[..split]).into_owned(), out[split + 4..].to_vec())
            };
            let enc = |p: &Path| {
                p.to_string_lossy()
                    .bytes()
                    .map(|b| if b.is_ascii_alphanumeric() || b == b'.' { (b as char).to_string() } else { format!("%{b:02X}") })
                    .collect::<String>()
            };

            let (h, body) = get(format!("/tok/{}", enc(&song)), None).await;
            assert!(h.starts_with("HTTP/1.1 200"), "{h}");
            assert!(h.contains("Content-Type: audio/mpeg") && h.contains("Accept-Ranges: bytes") && h.contains("Access-Control-Allow-Origin: *"));
            assert_eq!(body, bytes);

            let (h, body) = get(format!("/tok/{}", enc(&song)), Some("bytes=500-")).await;
            assert!(h.starts_with("HTTP/1.1 206") && h.contains("Content-Range: bytes 500-999/1000"), "{h}");
            assert_eq!(body, bytes[500..]);

            let (h, body) = get(format!("/tok/{}", enc(&song)), Some("bytes=10-19")).await;
            assert!(h.starts_with("HTTP/1.1 206"), "{h}");
            assert_eq!(body, bytes[10..20]);

            // Wrong secret, not audio, and outside the allowed folders: refused.
            assert!(get(format!("/bad/{}", enc(&song)), None).await.0.starts_with("HTTP/1.1 404"));
            assert!(get(format!("/tok/{}", enc(&dir.join("secret.txt"))), None).await.0.starts_with("HTTP/1.1 404"));
            assert!(get("/tok/%2Fetc%2Fpasswd".into(), None).await.0.starts_with("HTTP/1.1 404"));
            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn decodes_paths() {
        assert_eq!(percent_decode("%2Fhome%2Fme%2FMusic%2FKanye%20West%20-%20%C5%BBy%C4%87.mp3").unwrap(), "/home/me/Music/Kanye West - Żyć.mp3");
        assert!(percent_decode("%zz").is_none());
    }
}
