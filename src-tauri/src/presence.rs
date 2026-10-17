//! Discord Rich Presence: "Listening to <song>" on the user's Discord profile.
//! Talks to the Discord app running on this computer over its local IPC
//! socket (a named pipe on Windows, a Unix socket on Linux); nothing goes
//! over the internet from Aurora. Optional: Settings → Discord.

use std::io::{Read, Write};
use std::sync::Mutex;

use serde_json::{json, Value};

trait Pipe: Read + Write + Send {}
impl<T: Read + Write + Send> Pipe for T {}

#[derive(Default)]
pub struct Presence(Mutex<Option<(Box<dyn Pipe>, String)>>);

const NOT_RUNNING: &str = "Discord isn't running on this computer (the desktop app is needed for “Listening to” on your profile).";

fn connect() -> Option<Box<dyn Pipe>> {
    #[cfg(windows)]
    {
        for i in 0..10 {
            let name = format!(r"\\.\pipe\discord-ipc-{i}");
            if let Ok(f) = std::fs::OpenOptions::new().read(true).write(true).open(&name) {
                return Some(Box::new(f));
            }
        }
        None
    }
    #[cfg(unix)]
    {
        use std::os::unix::net::UnixStream;
        let mut bases: Vec<std::path::PathBuf> = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
            .iter()
            .filter_map(|v| std::env::var_os(v).map(Into::into))
            .collect();
        bases.push("/tmp".into());
        // The normal app, and the Flatpak / Snap / Vesktop ones.
        let subs = ["", "app/com.discordapp.Discord", "app/com.discordapp.DiscordCanary", "snap.discord", "app/dev.vencord.Vesktop", ".flatpak/dev.vencord.Vesktop/xdg-run"];
        for base in &bases {
            for sub in subs {
                for i in 0..10 {
                    let p = base.join(sub).join(format!("discord-ipc-{i}"));
                    if let Ok(s) = UnixStream::connect(&p) {
                        let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                        let _ = s.set_write_timeout(Some(std::time::Duration::from_secs(5)));
                        return Some(Box::new(s));
                    }
                }
            }
        }
        None
    }
}

fn write_frame(p: &mut dyn Pipe, op: u32, body: &Value) -> std::io::Result<()> {
    let data = serde_json::to_vec(body)?;
    let mut frame = Vec::with_capacity(8 + data.len());
    frame.extend_from_slice(&op.to_le_bytes());
    frame.extend_from_slice(&(data.len() as u32).to_le_bytes());
    frame.extend_from_slice(&data);
    p.write_all(&frame)?;
    p.flush()
}

fn read_frame(p: &mut dyn Pipe) -> std::io::Result<(u32, Value)> {
    let mut head = [0u8; 8];
    p.read_exact(&mut head)?;
    let op = u32::from_le_bytes(head[0..4].try_into().unwrap());
    let len = u32::from_le_bytes(head[4..8].try_into().unwrap()) as usize;
    if len > 1 << 20 {
        return Err(std::io::Error::other("frame too large"));
    }
    let mut body = vec![0u8; len];
    p.read_exact(&mut body)?;
    Ok((op, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

fn handshake(client_id: &str) -> Result<Box<dyn Pipe>, String> {
    let mut p = connect().ok_or(NOT_RUNNING)?;
    write_frame(p.as_mut(), 0, &json!({ "v": 1, "client_id": client_id })).map_err(|_| NOT_RUNNING.to_string())?;
    let (op, v) = read_frame(p.as_mut()).map_err(|_| NOT_RUNNING.to_string())?;
    if op == 2 || v.get("evt").and_then(|e| e.as_str()) == Some("ERROR") {
        let msg = v.pointer("/data/message").or_else(|| v.get("message")).and_then(|m| m.as_str()).unwrap_or("unknown error");
        return Err(format!("Discord refused the Application ID ({msg}). Check it in Settings → Discord."));
    }
    Ok(p)
}

fn set_activity(p: &mut dyn Pipe, activity: &Value) -> Result<(), String> {
    let nonce = format!("{:x}", rand::random::<u64>());
    let body = json!({ "cmd": "SET_ACTIVITY", "args": { "pid": std::process::id(), "activity": activity }, "nonce": nonce });
    write_frame(p, 1, &body).map_err(|e| e.to_string())?;
    // Skip unrelated frames until the answer to ours.
    for _ in 0..8 {
        let (op, v) = read_frame(p).map_err(|e| e.to_string())?;
        if op == 2 {
            return Err("Discord closed the connection".into());
        }
        if op == 3 {
            // PING → PONG
            let _ = write_frame(p, 4, &v);
            continue;
        }
        if v.get("nonce").and_then(|n| n.as_str()) == Some(nonce.as_str()) {
            if v.get("evt").and_then(|e| e.as_str()) == Some("ERROR") {
                return Err(v.pointer("/data/message").and_then(|m| m.as_str()).unwrap_or("Discord didn't accept the status").to_string());
            }
            return Ok(());
        }
    }
    Ok(())
}

/// Shows `activity` on the user's profile, or clears it (`None`).
#[tauri::command]
pub async fn presence_set(state: tauri::State<'_, Presence>, client_id: String, activity: Option<Value>) -> Result<(), String> {
    let client_id = client_id.trim().to_string();
    if client_id.len() < 15 || !client_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("The Application ID is the long number on your app's General Information page in the Discord Developer Portal.".into());
    }
    let activity = activity.unwrap_or(Value::Null);
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    // Try the open connection first, then reconnect once (Discord restarted, other app id…).
    for attempt in 0..2 {
        if slot.as_ref().map(|(_, id)| id != &client_id).unwrap_or(true) || attempt == 1 {
            *slot = None;
            if activity.is_null() && attempt == 0 {
                // Nothing shown on a fresh connection: nothing to clear.
                if connect().is_none() {
                    return Ok(());
                }
            }
            *slot = Some((handshake(&client_id)?, client_id.clone()));
        }
        let (pipe, _) = slot.as_mut().unwrap();
        match set_activity(pipe.as_mut(), &activity) {
            Ok(()) => return Ok(()),
            Err(e) if e.contains("status_display_type") || e.contains("Unknown field") => {
                // Older Discord: drop the newer field and try again.
                let mut a = activity.clone();
                if let Some(o) = a.as_object_mut() {
                    o.remove("status_display_type");
                }
                return set_activity(pipe.as_mut(), &a);
            }
            Err(e) if attempt == 1 => return Err(e),
            Err(_) => continue,
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    /// A pretend Discord app: answers the handshake and one SET_ACTIVITY.
    #[test]
    fn sets_activity_over_ipc() {
        let dir = std::env::temp_dir().join(format!("aurora-ipc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let listener = UnixListener::bind(dir.join("discord-ipc-0")).unwrap();
        std::env::set_var("XDG_RUNTIME_DIR", &dir);
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let (op, hello) = read_frame(&mut s).unwrap();
            assert_eq!(op, 0);
            assert_eq!(hello["client_id"], "123456789012345678");
            write_frame(&mut s, 1, &json!({ "cmd": "DISPATCH", "evt": "READY", "data": {} })).unwrap();
            let (op, msg) = read_frame(&mut s).unwrap();
            assert_eq!(op, 1);
            assert_eq!(msg["cmd"], "SET_ACTIVITY");
            write_frame(&mut s, 1, &json!({ "cmd": "SET_ACTIVITY", "nonce": msg["nonce"], "data": {} })).unwrap();
            msg["args"]["activity"]["details"].as_str().unwrap().to_string()
        });
        let mut p = handshake("123456789012345678").unwrap();
        set_activity(p.as_mut(), &json!({ "type": 2, "details": "Song" })).unwrap();
        assert_eq!(server.join().unwrap(), "Song");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
