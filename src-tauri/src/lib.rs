pub mod attachments;
pub mod auth;
pub mod avatars;
pub mod cli;
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
pub mod updater;

#[cfg(not(coverage))]
use tauri::Manager;

#[cfg(not(coverage))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some((message, code)) = cli::run_client(&std::env::args().collect::<Vec<_>>()) {
        println!("{message}");
        std::process::exit(code);
    }
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
            cli::start(handle);
            Ok(os::initialize(handle).map_err(std::io::Error::other)?)
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                os::window::on_close(window, event);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running LatentMail")
        .run(|handle, event| match event {
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                os::window::save_geometry(handle);
                let Some(lifecycle) = handle.state::<os::OsIntegration>().lifecycle().cloned()
                else {
                    return;
                };
                if let os::lifecycle::ExitDecision::Confirm { message, .. } =
                    lifecycle.exit_decision(code == Some(tauri::RESTART_EXIT_CODE))
                {
                    api.prevent_exit();
                    let app = handle.clone();
                    tauri_plugin_dialog::DialogExt::dialog(handle)
                        .message(message)
                        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                            "Wait".into(),
                            "Close Anyway".into(),
                        ))
                        .show(move |wait| {
                            if !wait {
                                app.state::<os::OsIntegration>()
                                    .lifecycle()
                                    .expect("lifecycle initialized")
                                    .confirm_close();
                                app.exit(0);
                            }
                        });
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => os::window::on_reopen(handle, has_visible_windows),
            _ => {}
        });
}
