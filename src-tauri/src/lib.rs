pub mod auth;
pub mod compose;
pub mod contacts;
pub mod gmail;
pub mod ipc;
pub mod logging;
pub mod queue;
pub mod sanitize;
pub mod settings;
pub mod storage;
pub mod sync;

#[cfg(not(coverage))]
use tauri::Manager;

#[cfg(not(coverage))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ipc::register(tauri::Builder::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle();
            let directory = handle.path().app_log_dir()?;
            handle.manage(logging::init(directory)?);
            settings::initialize(handle).map_err(std::io::Error::other)?;
            auth::initialize(handle).map_err(std::io::Error::other)?;
            Ok(sync::initialize(handle).map_err(std::io::Error::other)?)
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                settings::save_window(
                    window,
                    window
                        .app_handle()
                        .state::<settings::SettingsService>()
                        .inner(),
                );
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running LatentMail");
}
