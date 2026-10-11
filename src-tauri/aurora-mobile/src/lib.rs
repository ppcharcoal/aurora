//! Aurora's Android side. The app's Rust code calls [`AuroraMobile`] for the
//! things that need Android (searching and downloading through the bundled
//! extractor; there is no yt-dlp/FFmpeg on a phone), and the web UI talks to
//! the Kotlin playback service directly (`plugin:aurora-mobile|…`).

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "android")]
mod android;

/// One search hit from YouTube or SoundCloud.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: String,
    pub url: String,
    pub title: String,
    pub channel: Option<String>,
    pub duration_ms: u64,
    pub views: Option<u64>,
    pub thumb: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub items: Vec<Hit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamUrl {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Downloaded {
    /// Full path of the saved audio file (.m4a, .opus or .mp3).
    pub path: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub thumb: Option<String>,
}

pub type Result<T> = std::result::Result<T, String>;

/// Handle to the Kotlin plugin (`app.state::<AuroraMobile<R>>()`).
pub struct AuroraMobile<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _r: std::marker::PhantomData<fn() -> R>,
}

#[cfg(not(target_os = "android"))]
const NOT_HERE: &str = "This only works in Aurora for Android.";

impl<R: Runtime> AuroraMobile<R> {
    /// `site`: "youtube", "youtube-music" (songs only) or "soundcloud".
    pub fn search(&self, site: &str, query: &str, limit: u32) -> Result<Vec<Hit>> {
        #[cfg(target_os = "android")]
        {
            let r: SearchResult = self
                .handle
                .run_mobile_plugin("search", serde_json::json!({ "site": site, "query": query, "limit": limit }))
                .map_err(|e| e.to_string())?;
            Ok(r.items)
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (site, query, limit);
            Err(NOT_HERE.into())
        }
    }

    /// A direct audio URL for previews.
    pub fn stream(&self, url: &str) -> Result<String> {
        #[cfg(target_os = "android")]
        {
            let r: StreamUrl = self
                .handle
                .run_mobile_plugin("stream", serde_json::json!({ "url": url }))
                .map_err(|e| e.to_string())?;
            Ok(r.url)
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = url;
            Err(NOT_HERE.into())
        }
    }

    /// Downloads the best audio-only stream to `<dir>/<stem>.<ext>`, without
    /// converting it. Progress goes to the web UI as plugin event "progress"
    /// `{ id, percent, speed, eta }`. Blocks until done; call off the main thread.
    pub fn download(&self, job: &str, url: &str, dir: &str, stem: Option<&str>) -> Result<Downloaded> {
        #[cfg(target_os = "android")]
        {
            self.handle
                .run_mobile_plugin(
                    "download",
                    serde_json::json!({ "job": job, "url": url, "dir": dir, "stem": stem }),
                )
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (job, url, dir, stem);
            Err(NOT_HERE.into())
        }
    }

    pub fn cancel(&self, job: &str) {
        #[cfg(target_os = "android")]
        {
            let _ = self.handle.run_mobile_plugin::<serde_json::Value>("cancel", serde_json::json!({ "job": job }));
        }
        #[cfg(not(target_os = "android"))]
        let _ = job;
    }

    /// Tells the playback service the library or playlists changed (Android Auto lists).
    pub fn library_changed(&self) {
        #[cfg(target_os = "android")]
        {
            let _ = self.handle.run_mobile_plugin::<serde_json::Value>("reload", serde_json::json!({}));
        }
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("aurora-mobile")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let state = AuroraMobile::<R> { handle: android::register(_api)? };
            #[cfg(not(target_os = "android"))]
            let state = AuroraMobile::<R> { _r: std::marker::PhantomData };
            app.manage(state);
            Ok(())
        })
        .build()
}
