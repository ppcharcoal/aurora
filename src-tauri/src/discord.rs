//! Discord bot (Windows and Linux): runs Aurora's bot helper (discord/, a
//! small Node program using discord.js) and passes messages between it and
//! the window. The helper plays Aurora's songs in a voice channel; the
//! window stays in charge of what plays (see src/lib/discord.svelte.ts).
//!
//! The bot token is the user's own (Discord Developer Portal). It's kept in
//! `discord-bot.token` in Aurora's data folder: never shown again in full,
//! never sent anywhere but Discord, and never put in backups (they only take
//! `*.json` files).

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::rt::AppHandle;
use crate::store::data_dir;

#[derive(Default)]
pub struct DiscordBot(Mutex<Option<Helper>>);

struct Helper {
    child: Child,
    stdin: ChildStdin,
}

const TOKEN_FILE: &str = "discord-bot.token";

fn token_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(TOKEN_FILE))
}

fn read_token(app: &AppHandle) -> Option<String> {
    let t = std::fs::read_to_string(token_path(app).ok()?).ok()?;
    let t = t.trim().to_string();
    (!t.is_empty()).then_some(t)
}

/// Cleans up what people paste: spaces, quotes, a leading "Bot ".
fn clean_token(t: &str) -> String {
    let t = t.trim().trim_matches(|c| c == '"' || c == '\'' || c == '`').trim();
    let t = t.strip_prefix("Bot ").unwrap_or(t);
    t.chars().filter(|c| !c.is_whitespace()).collect()
}

/// The application id is the bot's user id, which is the token's first part (base64).
fn app_id_from_token(t: &str) -> Option<String> {
    let first = t.split('.').next()?;
    let mut s = first.replace('-', "+").replace('_', "/");
    while s.len() % 4 != 0 {
        s.push('=');
    }
    let bytes = base64_decode(&s)?;
    let id = String::from_utf8(bytes).ok()?;
    (id.len() >= 15 && id.chars().all(|c| c.is_ascii_digit())).then_some(id)
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0;
    for &c in s.as_bytes() {
        if c == b'=' {
            break;
        }
        let v = T.iter().position(|&x| x == c)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenInfo {
    saved: bool,
    /// "…AbCd": enough to recognise it, not to use it.
    hint: Option<String>,
    app_id: Option<String>,
}

#[tauri::command]
pub fn discord_token_info(app: AppHandle) -> TokenInfo {
    match read_token(&app) {
        Some(t) => TokenInfo {
            saved: true,
            hint: Some(format!("…{}", &t[t.len().saturating_sub(4)..])),
            app_id: app_id_from_token(&t),
        },
        None => TokenInfo { saved: false, hint: None, app_id: None },
    }
}

/// Saves the token (or forgets it with `None`). Returns the bot's application id.
#[tauri::command]
pub fn discord_token_set(app: AppHandle, token: Option<String>) -> Result<Option<String>, String> {
    let path = token_path(&app)?;
    match token.map(|t| clean_token(&t)).filter(|t| !t.is_empty()) {
        Some(t) => {
            if t.split('.').count() != 3 || t.len() < 50 {
                return Err("That doesn't look like a bot token. In the Developer Portal open your app → Bot → Reset Token, then Copy (it's about 70 characters with two dots).".into());
            }
            let id = app_id_from_token(&t);
            if id.is_none() {
                return Err("That doesn't look like a bot token (it should start with the bot's id). Copy it from Bot → Reset Token, not the Client Secret or Public Key.".into());
            }
            std::fs::write(&path, &t).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
            Ok(id)
        }
        None => {
            let _ = std::fs::remove_file(&path);
            Ok(None)
        }
    }
}

/// Where the helper script is: next to the Electron app, in the Windows
/// install's resources, or in the source tree while developing.
fn helper_script(app: &AppHandle) -> Option<PathBuf> {
    let mut tries = Vec::new();
    if let Some(p) = std::env::var_os("AURORA_DISCORD_HELPER") {
        tries.push(PathBuf::from(p));
    }
    if let Ok(dir) = app.path().resource_dir() {
        tries.push(dir.join("discord").join("aurora-discord.cjs"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            tries.push(dir.join("discord").join("aurora-discord.cjs"));
        }
    }
    tries.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("discord").join("dist").join("aurora-discord.cjs"));
    tries.into_iter().find(|p| p.is_file())
}

/// The JavaScript runtime that runs the helper: Electron's own (Linux app),
/// Node.js if installed, or the Deno that Aurora installs for yt-dlp.
fn runtime(app: &AppHandle, script: &PathBuf) -> Result<Command, String> {
    if let Some(node) = std::env::var_os("AURORA_NODE") {
        let mut c = Command::new(node);
        c.env("ELECTRON_RUN_AS_NODE", "1").arg(script);
        return Ok(c);
    }
    let resolved = crate::tools::resolve(app)?;
    let on_path = |name: &str| {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .map(|d| d.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)))
            .find(|p| p.is_file())
    };
    if let Some(node) = on_path("node") {
        let mut c = Command::new(node);
        c.arg(script);
        return Ok(c);
    }
    if let Some((_, deno)) = resolved.js.filter(|(k, _)| k == "deno") {
        let mut c = Command::new(deno);
        c.args(["run", "-A", "--no-config", "--node-modules-dir=none", "--quiet"]).arg(script);
        return Ok(c);
    }
    Err("The Discord bot needs a JavaScript runtime. Settings → Download tools → Install (it adds Deno), or install Node.js.".into())
}

fn ffmpeg_path(app: &AppHandle) -> String {
    crate::tools::resolve(app)
        .ok()
        .and_then(|r| r.ffmpeg_dir)
        .map(|d| d.join(format!("ffmpeg{}", std::env::consts::EXE_SUFFIX)).display().to_string())
        .unwrap_or_else(|| "ffmpeg".into())
}

fn write_line(h: &mut Helper, msg: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    line.push('\n');
    h.stdin.write_all(line.as_bytes()).and_then(|_| h.stdin.flush()).map_err(|_| "The Discord bot stopped. Connect it again.".to_string())
}

/// Starts the bot with the saved token. Messages from it arrive as `discord://event`.
#[tauri::command]
pub fn discord_start(app: AppHandle, state: tauri::State<'_, DiscordBot>, control: String, now_playing: bool) -> Result<(), String> {
    let token = read_token(&app).ok_or("Add your bot token first.")?;
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut old) = slot.take() {
        let _ = old.child.kill();
        let _ = old.child.wait();
    }
    let script = helper_script(&app).ok_or("The Discord bot isn't part of this build of Aurora.")?;
    let mut cmd = runtime(&app, &script)?;
    if let Some(dir) = script.parent() {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).env("NO_COLOR", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // no console window
    }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start the Discord bot: {e}"))?;
    let stdin = child.stdin.take().ok_or("Couldn't start the Discord bot.")?;
    let stdout = child.stdout.take().ok_or("Couldn't start the Discord bot.")?;
    let stderr = child.stderr.take();
    let pid = child.id();

    let events = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let _ = events.emit("discord://event", v);
            }
        }
        let _ = events.emit("discord://event", serde_json::json!({ "t": "exit", "pid": pid }));
    });
    if let Some(err) = stderr {
        // Diagnostics (warnings from libraries); kept out of the window, last lines in the log.
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                eprintln!("[discord] {line}");
            }
        });
    }

    let mut helper = Helper { child, stdin };
    write_line(
        &mut helper,
        &serde_json::json!({ "t": "start", "token": token, "ffmpeg": ffmpeg_path(&app), "control": control, "nowPlaying": now_playing }),
    )?;
    *slot = Some(helper);
    Ok(())
}

/// Passes a message to the running bot (join, play, pause, reply…).
#[tauri::command]
pub fn discord_send(state: tauri::State<'_, DiscordBot>, msg: Value) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    let h = slot.as_mut().ok_or("The Discord bot isn't running.")?;
    let r = write_line(h, &msg);
    if r.is_err() {
        *slot = None;
    }
    r
}

/// Disconnects the bot (it leaves the voice channel first).
#[tauri::command]
pub fn discord_stop(state: tauri::State<'_, DiscordBot>) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut h) = slot.take() {
        let _ = write_line(&mut h, &serde_json::json!({ "t": "quit" }));
        std::thread::spawn(move || {
            for _ in 0..30 {
                if matches!(h.child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            let _ = h.child.kill();
            let _ = h.child.wait();
        });
    }
    Ok(())
}

impl Drop for DiscordBot {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.0.lock() {
            if let Some(mut h) = slot.take() {
                let _ = h.child.kill();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_app_id_from_token() {
        // "123456789012345678" in base64, then two made-up parts (put together
        // here so it doesn't look like a real token to secret scanners).
        let t = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "x", &"a".repeat(38)].join(".");
        let t = t.as_str();
        assert_eq!(app_id_from_token(t).as_deref(), Some("123456789012345678"));
        assert_eq!(clean_token(&format!(" Bot {t}\n")), t);
        assert_eq!(app_id_from_token("not-a-token"), None);
    }
}
