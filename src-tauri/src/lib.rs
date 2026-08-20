pub mod attachments;
pub mod auth;
pub mod avatars;
pub mod compose;
pub mod contacts;
pub mod gmail;
pub mod ipc;
pub mod logging;
pub mod os;
pub mod queue;
pub mod sanitize;
pub mod search;
pub mod settings;
pub mod shell;
pub mod storage;
pub mod sync;

#[cfg(not(coverage))]
use tauri::Manager;

#[cfg(not(coverage))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    shell::register_plugins(ipc::register(tauri::Builder::default()))
        .setup(|app| {
            let handle = app.handle();
            let directory = handle.path().app_log_dir()?;
            let (guard, level_handle) = logging::init(directory)?;
            handle.manage(guard);
            handle.manage(level_handle);
            settings::initialize(handle).map_err(std::io::Error::other)?;
            auth::initialize(handle).map_err(std::io::Error::other)?;
            avatars::initialize(handle).map_err(std::io::Error::other)?;
            sync::initialize(handle).map_err(std::io::Error::other)?;
            Ok(os::initialize(handle).map_err(std::io::Error::other)?)
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                os::window::on_close(window, event);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running LatentMail")
        .run(|handle, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                os::window::save_geometry(handle);
            }
        });
}
