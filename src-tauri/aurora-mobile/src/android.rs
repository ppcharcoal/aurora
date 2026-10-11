use tauri::{
    plugin::{PluginApi, PluginHandle},
    Runtime,
};

const PLUGIN_IDENTIFIER: &str = "app.aurora.mobile";

pub fn register<R: Runtime>(api: PluginApi<R, ()>) -> Result<PluginHandle<R>, Box<dyn std::error::Error>> {
    Ok(api.register_android_plugin(PLUGIN_IDENTIFIER, "AuroraMobilePlugin")?)
}
