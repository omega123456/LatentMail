use tauri::plugin::TauriPlugin;
use tauri::Builder;
use tauri::Wry;
use tauri_plugin_prevent_default::Flags;

pub fn prevent_default_flags(debug: bool) -> Flags {
    let flags = Flags::all().difference(Flags::FOCUS_MOVE);
    if debug {
        flags.difference(Flags::DEV_TOOLS)
    } else {
        flags
    }
}

pub fn prevent_default_plugin() -> TauriPlugin<Wry> {
    let builder = tauri_plugin_prevent_default::Builder::new()
        .with_flags(prevent_default_flags(cfg!(debug_assertions)));

    #[cfg(windows)]
    let builder = builder.platform(
        tauri_plugin_prevent_default::PlatformOptions::new()
            .general_autofill(false)
            .password_autosave(false)
            .browser_accelerator_keys(cfg!(debug_assertions))
            .dev_tools(true),
    );

    builder.build()
}

pub fn register_plugins(builder: Builder<Wry>) -> Builder<Wry> {
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            crate::os::window::show_and_focus(app);
            if let Some(value) = crate::os::instance::mailto_argument(&args) {
                crate::os::emit_mailto(app, value);
            }
        }))
        .plugin(tauri_plugin_deep_link::init());
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None::<Vec<&str>>,
    ));
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(prevent_default_plugin())
}
