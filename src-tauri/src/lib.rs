mod backup;
mod catalog;
mod lastfm;
mod images;
mod library;
mod mp4fix;
mod storage;
mod store;
#[cfg(not(aurora_android))]
mod tools;
mod yt;
#[cfg(aurora_android)]
mod yt_android;

use tauri::Manager;

#[cfg(not(aurora_android))]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
            store::store_get,
            store::store_set,
            library::library_get,
            library::library_add_folder,
            library::library_remove_folder,
            library::library_rescan,
            library::library_import,
            library::library_remove_copies,
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
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
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

/// WebKitGTK draws a blank or flickering window on NVIDIA with Wayland
/// compositors such as Hyprland unless its DMA-BUF renderer is turned off.
/// Only done when the NVIDIA driver is loaded and the user hasn't chosen.
fn linux_display_fixes() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() && std::path::Path::new("/proc/driver/nvidia").exists() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

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
            let state = library::LibraryState::load(&handle)?;
            app.manage(state);
            images::allow(&handle)?;
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
