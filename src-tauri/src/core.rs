//! `aurora-core`: Aurora's Rust side without a window, for the Electron app on Linux.
//!
//! Every command the Tauri app has runs here unchanged: the app is built on
//! Tauri's window-less runtime and commands are dispatched exactly as the web
//! view would dispatch them. Electron draws the interface and talks to this
//! process over one loopback TCP connection:
//!
//! - On start, prints `AURORA_CORE <port> <token>` on stdout and waits for one connection.
//! - The client sends the token as its first line, then one JSON object per line:
//!   `{"id": 1, "cmd": "library_get", "args": {...}}`.
//! - Replies, one per line: `{"id": 1, "ok": true, "data": ...}` or `{"id": 1, "ok": false, "error": ...}`.
//! - Events the app emits (download progress…): `{"event": "download://progress", "payload": ...}`.
//! - When the connection closes (Electron quit or crashed), the process exits.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Listener, Manager, WebviewWindowBuilder};

use crate::{handlers, images, library, media_server, store, yt};

/// Everything the Rust side emits; forwarded to the window as events.
const EVENTS: &[&str] = &[
    "backup://progress",
    "download://progress",
    "download://retry",
    "discord://event",
    "library://progress",
    "storage://progress",
    "tools://progress",
];

type Out = Arc<Mutex<TcpStream>>;

fn send(out: &Out, line: String) {
    if let Ok(mut s) = out.lock() {
        if s.write_all(line.as_bytes()).and_then(|_| s.write_all(b"\n")).is_err() {
            std::process::exit(0);
        }
    }
}

pub fn main() {
    let mut ctx = mock_context(noop_assets());
    // Same data folder as the Tauri app (~/.local/share/app.aurora.player).
    ctx.config_mut().identifier = "app.aurora.player".into();
    ctx.config_mut().product_name = Some("Aurora".into());

    let app = mock_builder()
        .plugin(tauri_plugin_opener::init())
        .manage(yt::Downloads::default())
        .manage(crate::discord::DiscordBot::default())
        .manage(crate::presence::Presence::default())
        .manage(crate::loudness::LoudnessCache::default())
        .invoke_handler(handlers())
        .build(ctx)
        .expect("Aurora core failed to start");

    // What the Tauri app does in `setup` (the window-less app has no start-up event to run it from).
    let handle = app.handle().clone();
    let state = library::LibraryState::load(&handle).expect("couldn't read the music library index");
    app.manage(state);
    let _ = images::allow(&handle);
    // Songs and covers reach the window over the private local web server.
    let base = media_server::start(&handle).ok();
    app.manage(media_server::MediaBase(base));
    if let Ok(dir) = store::data_dir(&handle).map(|d| d.join("previews")) {
        let _ = std::fs::create_dir_all(&dir);
        let _ = app.asset_protocol_scope().allow_directory(&dir, false);
    }

    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("Aurora core failed to start");

    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("no loopback port");
    let port = listener.local_addr().expect("no loopback port").port();
    let token: String = (0..16).map(|_| format!("{:02x}", rand::random::<u8>())).collect();
    println!("AURORA_CORE {port} {token}");
    let _ = std::io::stdout().flush();

    // One client: the Electron app that started us.
    let stream = loop {
        let Ok((stream, addr)) = listener.accept() else { continue };
        if !addr.ip().is_loopback() {
            continue;
        }
        let mut first = String::new();
        let mut reader = BufReader::new(stream.try_clone().expect("socket"));
        if reader.read_line(&mut first).is_ok() && first.trim() == token {
            break (stream, reader);
        }
    };
    drop(listener);
    let (stream, reader) = stream;
    let _ = stream.set_nodelay(true);
    let out: Out = Arc::new(Mutex::new(stream));

    for name in EVENTS {
        let out = out.clone();
        app.listen_any(*name, move |e| {
            let payload = if e.payload().is_empty() { "null" } else { e.payload() };
            send(&out, format!("{{\"event\":{},\"payload\":{}}}", Value::from(*name), payload));
        });
    }

    // Calls come from the app's own page (a "local" origin), as in the Tauri app.
    let url = webview.url().expect("Aurora core failed to start");
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let cmd = msg.get("cmd").and_then(|c| c.as_str()).unwrap_or_default().to_string();
        let args = msg.get("args").cloned().unwrap_or_else(|| Value::Object(Default::default()));
        let (out, webview, url) = (out.clone(), webview.clone(), url.clone());
        // Each call on its own thread: long ones (downloads, scans) don't hold up the rest.
        std::thread::spawn(move || {
            let request = InvokeRequest {
                cmd,
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url,
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            };
            let reply = match get_ipc_response(&webview, request) {
                Ok(InvokeResponseBody::Json(data)) => {
                    let data = if data.is_empty() { "null".to_string() } else { data };
                    format!("{{\"id\":{id},\"ok\":true,\"data\":{data}}}")
                }
                Ok(InvokeResponseBody::Raw(bytes)) => {
                    format!("{{\"id\":{id},\"ok\":true,\"data\":{}}}", Value::from(bytes))
                }
                Err(err) => format!("{{\"id\":{id},\"ok\":false,\"error\":{err}}}"),
            };
            send(&out, reply);
        });
    }
    // Electron is gone: stop downloads and helpers with us.
    std::process::exit(0);
}
