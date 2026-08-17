use tauri::plugin::TauriPlugin;
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
    let builder =
        tauri_plugin_prevent_default::Builder::new().with_flags(prevent_default_flags(cfg!(
            debug_assertions
        )));

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
