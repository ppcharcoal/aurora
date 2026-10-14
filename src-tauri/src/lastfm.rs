//! Last.fm API client. Signing (md5 with the shared secret) happens here so the
//! web layer never builds signatures itself.
//!
//! The API key + secret belong to the user (free from last.fm/api/account/create)
//! and live in lastfm-app.json. Session keys are per Aurora profile.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::store::data_dir;

const API: &str = "https://ws.audioscrobbler.com/2.0/";
const CALLBACK_PORT: u16 = 43822;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppKeys {
    api_key: String,
    secret: String,
}

#[derive(Serialize)]
pub struct Session {
    name: String,
    key: String,
}

fn keys(app: &AppHandle) -> Result<AppKeys, String> {
    // A key built into this copy of Aurora (see build.rs) always wins, so
    // users never have to deal with keys.
    if let (Some(k), Some(s)) = (option_env!("AURORA_LASTFM_KEY"), option_env!("AURORA_LASTFM_SECRET")) {
        return Ok(AppKeys { api_key: k.into(), secret: s.into() });
    }
    // Otherwise the key the user pasted in (Profile → Last.fm).
    let path = data_dir(app)?.join("lastfm-app.json");
    let k: AppKeys = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    if !k.api_key.trim().is_empty() && !k.secret.trim().is_empty() {
        return Ok(AppKeys { api_key: k.api_key.trim().into(), secret: k.secret.trim().into() });
    }
    Err("Add your Last.fm API key and secret first (Profile → Last.fm).".into())
}

/// True when this build has a Last.fm key built in (users just sign in).
#[tauri::command]
pub fn lastfm_builtin() -> bool {
    option_env!("AURORA_LASTFM_KEY").is_some()
}

/// api_sig: params sorted by name, "namevalue" concatenated, secret appended,
/// md5 → hex. `format` and `callback` are never signed.
pub fn sign(params: &BTreeMap<String, String>, secret: &str) -> String {
    let mut s = String::new();
    for (k, v) in params {
        if k == "format" || k == "callback" {
            continue;
        }
        s.push_str(k);
        s.push_str(v);
    }
    s.push_str(secret);
    format!("{:x}", md5::compute(s.as_bytes()))
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Aurora/0.1 (desktop music player)")
        .timeout(Duration::from_secs(20))
        .build()
        .expect("http client")
}

/// Turns a Last.fm error body into a readable message.
/// Codes 11/16 are temporary (retry later); 9 means the session was revoked.
fn api_error(v: &Value) -> Option<String> {
    let code = v.get("error")?.as_i64()?;
    let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("Last.fm error");
    Some(match code {
        9 => "LASTFM_SESSION: Your Last.fm sign-in was revoked. Connect again in Profile → Last.fm.".into(),
        11 | 16 => format!("LASTFM_RETRY: Last.fm is temporarily unavailable ({msg})."),
        29 => "LASTFM_RETRY: Too many requests to Last.fm; trying again shortly.".into(),
        10 | 26 => "Your Last.fm API key isn't valid. Check it in Profile → Last.fm.".into(),
        6 => format!("Last.fm: {msg}"),
        _ => format!("Last.fm error {code}: {msg}"),
    })
}

async fn call_raw(
    keys: &AppKeys,
    method: &str,
    mut params: BTreeMap<String, String>,
    sk: Option<&str>,
    write: bool,
) -> Result<Value, String> {
    params.insert("method".into(), method.into());
    params.insert("api_key".into(), keys.api_key.clone());
    let signed = write || sk.is_some() || method.starts_with("auth.");
    if let Some(sk) = sk {
        params.insert("sk".into(), sk.into());
    }
    if signed {
        let sig = sign(&params, &keys.secret);
        params.insert("api_sig".into(), sig);
    }
    params.insert("format".into(), "json".into());

    let req = if write {
        client().post(API).form(&params)
    } else {
        client().get(API).query(&params)
    };
    let res = req.send().await.map_err(|e| format!("LASTFM_RETRY: Can't reach Last.fm ({e})."))?;
    let v: Value = res.json().await.map_err(|e| format!("Unexpected Last.fm answer: {e}"))?;
    // Always check the body: HTTP 200 doesn't guarantee success.
    match api_error(&v) {
        Some(e) => Err(e),
        None => Ok(v),
    }
}

/// Generic call used by the frontend. `write` = POST + signed (scrobble, love…).
#[tauri::command]
pub async fn lastfm_call(
    app: AppHandle,
    method: String,
    params: BTreeMap<String, String>,
    sk: Option<String>,
    write: Option<bool>,
) -> Result<Value, String> {
    let allowed = method.split('.').next().map_or(false, |p| {
        ["track", "user", "artist", "album", "tag", "chart"].contains(&p)
    });
    if !allowed {
        return Err("Unsupported Last.fm method.".into());
    }
    let k = keys(&app)?;
    call_raw(&k, &method, params, sk.as_deref(), write.unwrap_or(false)).await
}

/// Browser sign-in, the way Last.fm's own desktop apps do it:
/// 1. ask Last.fm for a token, 2. open the approval page for that token,
/// 3. keep asking Last.fm for a session until the user has approved.
/// Step 3 doesn't depend on the browser coming back to Aurora, which phones
/// don't reliably do. On a PC the page also redirects to a small local page
/// that says "you can close this tab" (if that port is free).
#[tauri::command]
pub async fn lastfm_login(app: AppHandle) -> Result<Session, String> {
    let k = keys(&app)?;
    let v = call_raw(&k, "auth.getToken", BTreeMap::new(), None, false).await?;
    let token = v.get("token").and_then(|t| t.as_str()).ok_or("Last.fm didn't return a sign-in token.")?.to_string();

    // Optional "done" page. Not needed for the sign-in itself.
    let listener = TcpListener::bind(("127.0.0.1", CALLBACK_PORT)).await.ok();
    let mut params: Vec<(&str, String)> = vec![("api_key", k.api_key.clone()), ("token", token.clone())];
    if listener.is_some() && !cfg!(aurora_android) {
        params.push(("cb", format!("http://127.0.0.1:{CALLBACK_PORT}/lastfm")));
    }
    let url = url::Url::parse_with_params("https://www.last.fm/api/auth/", &params).map_err(|e| e.to_string())?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| format!("Couldn't open the browser: {e}"))?;
    let page = listener.map(|l| tauri::async_runtime::spawn(serve_done_page(l)));

    let result = tokio::time::timeout(Duration::from_secs(600), async {
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let mut p = BTreeMap::new();
            p.insert("token".to_string(), token.clone());
            match call_raw(&k, "auth.getSession", p, None, false).await {
                Ok(v) => return Ok(v),
                // 14: not approved yet. Temporary network trouble: keep waiting.
                Err(e) if e.starts_with("Last.fm error 14") || e.starts_with("LASTFM_RETRY") => continue,
                Err(e) if e.starts_with("Last.fm error 15") || e.starts_with("Last.fm error 4") => {
                    return Err("The Last.fm sign-in expired. Please try again.".to_string())
                }
                Err(e) => return Err(e),
            }
        }
    })
    .await;
    if let Some(h) = page {
        h.abort();
    }
    let v = result.map_err(|_| "Last.fm sign-in timed out. Please try again.".to_string())??;
    let s = v.get("session").ok_or("Last.fm didn't return a session.")?;
    Ok(Session {
        name: s.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
        key: s.get("key").and_then(|n| n.as_str()).ok_or("Last.fm didn't return a session key.")?.to_string(),
    })
}

/// Answers the browser after the approval with a small "you're connected" page.
async fn serve_done_page(listener: TcpListener) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else { return };
        let mut buf = vec![0u8; 8192];
        let _ = stream.read(&mut buf).await;
        let html = "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>Aurora</title><body style=\"margin:0;height:100vh;display:grid;place-items:center;background:#15121c;color:#f1edf7;font:16px 'Segoe UI',sans-serif\"><div style=text-align:center><h1 style=font-weight:600>Connected to Last.fm</h1><p style=opacity:.7>You can close this tab and go back to Aurora.</p></div>";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
            html.len()
        );
        let _ = stream.write_all(resp.as_bytes()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_matches_last_fm_docs() {
        // Last.fm's documented example string: api_key…method…token…secret
        let mut p = BTreeMap::new();
        p.insert("token".to_string(), "TOKEN".to_string());
        p.insert("method".to_string(), "auth.getSession".to_string());
        p.insert("api_key".to_string(), "KEY".to_string());
        p.insert("format".to_string(), "json".to_string());
        let expected = format!("{:x}", md5::compute("api_keyKEYmethodauth.getSessiontokenTOKENSECRET"));
        assert_eq!(sign(&p, "SECRET"), expected);
    }

    #[test]
    fn array_params_sort_like_last_fm_expects() {
        // Batch scrobbles use artist[0], artist[1]… which must sort as strings.
        let mut p = BTreeMap::new();
        p.insert("track[1]".to_string(), "B".to_string());
        p.insert("artist[0]".to_string(), "A".to_string());
        p.insert("track[0]".to_string(), "A".to_string());
        let s = sign(&p, "x");
        let expected = format!("{:x}", md5::compute("artist[0]Atrack[0]Atrack[1]Bx"));
        assert_eq!(s, expected);
    }

    #[test]
    fn classifies_errors() {
        assert!(api_error(&serde_json::json!({"error": 9, "message": "Invalid session key"})).unwrap().starts_with("LASTFM_SESSION"));
        assert!(api_error(&serde_json::json!({"error": 16, "message": "x"})).unwrap().starts_with("LASTFM_RETRY"));
        assert!(api_error(&serde_json::json!({"recenttracks": {}})).is_none());
    }
}
