// The Kotlin side lives in ./android and is linked into the app's Gradle
// project by `tauri android init` / `tauri android build`.
// Permissions are written by hand in ./permissions (some commands are
// answered straight by Kotlin, including the listener commands).
fn main() {
    tauri_plugin::Builder::new(&[]).android_path("android").build();
}
