fn main() {
    // `aurora_android`: the phone build. The `simulate-android` feature turns it
    // on for a desktop `cargo check`, so the Android code paths can be
    // type-checked without the Android toolchain.
    println!("cargo::rustc-check-cfg=cfg(aurora_android)");
    let android = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android");
    if android || std::env::var_os("CARGO_FEATURE_SIMULATE_ANDROID").is_some() {
        println!("cargo:rustc-cfg=aurora_android");
    }
    // Optional: put {"apiKey": "...", "secret": "..."} in src-tauri/lastfm-key.json
    // and the app ships with that Last.fm key, so users only sign in with the
    // browser. Without the file, users enter their own key in the app.
    println!("cargo:rerun-if-changed=lastfm-key.json");
    if let Ok(text) = std::fs::read_to_string("lastfm-key.json") {
        let find = |name: &str| -> Option<String> {
            let i = text.find(&format!("\"{name}\""))?;
            let rest = &text[i + name.len() + 2..];
            let start = rest.find('"')? + 1;
            let end = rest[start..].find('"')? + start;
            Some(rest[start..end].trim().to_string())
        };
        if let (Some(k), Some(s)) = (find("apiKey"), find("secret")) {
            if k.len() >= 20 && s.len() >= 20 {
                println!("cargo:rustc-env=AURORA_LASTFM_KEY={k}");
                println!("cargo:rustc-env=AURORA_LASTFM_SECRET={s}");
            }
        }
    }
    tauri_build::build()
}
