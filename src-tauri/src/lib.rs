mod backup;
mod catalog;
mod lastfm;
mod images;
mod library;
#[cfg(not(aurora_android))]
mod discord;
#[cfg(not(aurora_android))]
mod media_server;
#[cfg(not(aurora_android))]
mod presence;
mod mp4fix;
mod storage;
mod store;
#[cfg(not(aurora_android))]
mod tools;
mod yt;
#[cfg(aurora_android)]
mod yt_android;
#[cfg(feature = "core")]
mod core;

/// Which Tauri runtime the commands run on: the real window (Wry), or none
/// for `aurora-core`, the window-less helper behind the Electron Linux app.
pub(crate) mod rt {
    #[cfg(feature = "core")]
    pub type Rt = tauri::test::MockRuntime;
    #[cfg(not(feature = "core"))]
    pub type Rt = tauri::Wry;
    pub type AppHandle = tauri::AppHandle<Rt>;
}

#[cfg(feature = "core")]
pub use crate::core::main as core_main;

#[cfg(not(feature = "core"))]
use tauri::Manager;

#[cfg(not(aurora_android))]
fn handlers() -> impl Fn(tauri::ipc::Invoke<rt::Rt>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
            store::store_get,
            store::store_set,
            library::library_get,
            library::library_add_folder,
            library::library_remove_folder,
            library::library_rescan,
            library::library_import,
            library::library_remove_copies,
            media_server::media_base,
            discord::discord_token_info,
            discord::discord_token_set,
            discord::discord_start,
            discord::discord_send,
            discord::discord_stop,
            presence::presence_set,
            tools::tools_status,
            tools::tools_install,
            tools::tools_update,
            yt::yt_search,
            yt::yt_search_albums,
            yt::yt_find_source,
            yt::yt_stream_url,
            catalog::catalog_search_tracks,
            catalog::catalog_search_albums,
            catalog::catalog_match_tracks,
            catalog::catalog_match_album,
            catalog::catalog_artist_picture,
            lastfm::lastfm_call,
            lastfm::lastfm_login,
            lastfm::lastfm_builtin,
            yt::yt_download,
            yt::yt_cancel,
            images::image_store,
            images::image_store_url,
            images::disk_space,
            images::image_remove,
            images::app_paths,
            images::image_color,
            storage::storage_estimate,
            storage::storage_slim,
            backup::backup_estimate,
            backup::backup_create,
            backup::backup_restore,
    ]
}

/// The phone build: same commands, with Android versions of the download ones.
#[cfg(aurora_android)]
fn handlers() -> impl Fn(tauri::ipc::Invoke<rt::Rt>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
            store::store_get,
            store::store_set,
            library::library_get,
            library::library_add_folder,
            library::library_remove_folder,
            library::library_rescan,
            library::library_import,
            library::library_remove_copies,
            yt_android::tools_status,
            yt_android::tools_install,
            yt_android::tools_update,
            yt_android::yt_search,
            yt_android::yt_search_albums,
            yt_android::yt_find_source,
            yt_android::yt_stream_url,
            catalog::catalog_search_tracks,
            catalog::catalog_search_albums,
            catalog::catalog_match_tracks,
            catalog::catalog_match_album,
            catalog::catalog_artist_picture,
            lastfm::lastfm_call,
            lastfm::lastfm_login,
            lastfm::lastfm_builtin,
            yt_android::yt_download,
            yt_android::yt_cancel,
            images::image_store,
            images::image_store_url,
            images::disk_space,
            images::image_remove,
            images::app_paths,
            images::image_color,
            storage::storage_estimate,
            storage::storage_slim,
            backup::backup_estimate,
            backup::backup_create,
            backup::backup_restore,
            backup::backup_create_fd,
            backup::backup_restore_fd,
    ]
}

/// WebKitGTK's DMA-BUF renderer makes Aurora redraw at full cost while music
/// plays: measured ~150% CPU vs ~15% without it, enough to make the app lag
/// and the music (decoded in the same process) stutter. On NVIDIA with
/// Wayland compositors such as Hyprland it can also give a blank window.
/// So it's off on Linux unless the user sets the variable themselves, or
/// AURORA_DMABUF=1 to keep it.
#[cfg(not(feature = "core"))]
fn linux_display_fixes() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() && std::env::var_os("AURORA_DMABUF").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg(not(feature = "core"))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    linux_display_fixes();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_aurora_mobile::init())
        .manage(yt::Downloads::default())
        // Windows only tells the page the names of speakers/headphones after a
        // media permission (used once by Settings → Audio output; nothing is recorded).
        .on_permission_request(|_, kind| match kind {
            tauri::webview::PermissionKind::Microphone => tauri::webview::PermissionResponse::Allow,
            _ => tauri::webview::PermissionResponse::Default,
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // Discord bot + Rich Presence (Windows and Linux).
            #[cfg(not(aurora_android))]
            {
                app.manage(discord::DiscordBot::default());
                app.manage(presence::Presence::default());
            }
            let state = library::LibraryState::load(&handle)?;
            app.manage(state);
            images::allow(&handle)?;
            // Linux: songs reach the player over a private local web server
            // (GStreamer can't read the asset:// scheme). See media_server.rs.
            #[cfg(not(aurora_android))]
            {
                let base = if cfg!(target_os = "linux") { media_server::start(&handle).ok() } else { None };
                app.manage(media_server::MediaBase(base));
            }
            // Safety net: the page shows the window when it's ready; if that
            // never happens (a page error), show it anyway instead of staying invisible.
            if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                });
            }
            // Tiling window managers (Hyprland, Sway…) may give Aurora a narrow
            // tile: allow it, the layout switches to the compact phone one.
            #[cfg(target_os = "linux")]
            if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                let _ = w.set_min_size(Some(tauri::LogicalSize::new(360.0, 480.0)));
            }
            // Preview clips (see yt::yt_stream_url) are played from here.
            if let Ok(dir) = store::data_dir(&handle).map(|d| d.join("previews")) {
                let _ = std::fs::create_dir_all(&dir);
                let _ = app.asset_protocol_scope().allow_directory(&dir, false);
            }
            Ok(())
        })
        .invoke_handler(handlers())
        .run(tauri::generate_context!())
        .expect("error while running Aurora");
}
