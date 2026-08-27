pub mod ai;
pub mod attachments;
pub mod auth;
pub mod avatars;
pub mod cli;
pub mod compose;
pub mod contacts;
pub mod gmail;
pub mod inline_images;
pub mod ipc;
pub mod logging;
pub mod os;
pub mod queue;
pub mod remote_images;
pub mod sanitize;
pub mod search;
pub mod settings;
pub mod shell;
pub mod storage;
pub mod sync;
pub mod updater;

pub fn http_client() -> reqwest::Client {
    let builder = reqwest::Client::builder();
    #[cfg(feature = "test-utils")]
    let builder = builder.no_proxy();
    builder.build().expect("http client")
}

#[cfg(not(coverage))]
use tauri::Manager;

#[cfg(all(windows, not(coverage)))]
fn attach_parent_console() {
    use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};

    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(all(not(windows), not(coverage)))]
fn attach_parent_console() {}

#[cfg(not(coverage))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some((message, code)) = cli::run_client(&std::env::args().collect::<Vec<_>>()) {
        attach_parent_console();
        println!("{message}");
        std::process::exit(code);
    }
    let image_client = http_client();
    shell::register_plugins(ipc::register(tauri::Builder::default()))
        .register_asynchronous_uri_scheme_protocol(
            remote_images::SCHEME,
            move |_app, request, responder| {
                let client = image_client.clone();
                let uri = request.uri().to_string();
                tauri::async_runtime::spawn(async move {
                    responder.respond(remote_images::respond(&client, &uri).await);
                });
            },
        )
        .register_asynchronous_uri_scheme_protocol(
            inline_images::SCHEME,
            |app, request, responder| {
                let Some(storage) = app
                    .app_handle()
                    .try_state::<storage::Storage>()
                    .map(|state| state.inner().clone())
                else {
                    return;
                };
                let uri = request.uri().to_string();
                tauri::async_runtime::spawn(async move {
                    responder.respond(inline_images::respond(&storage, &uri).await);
                });
            },
        )
        .setup(|app| {
            let handle = app.handle();
            let directory = handle.path().app_log_dir()?;
            let (guard, level_handle) = logging::init(directory)?;
            handle.manage(guard);
            handle.manage(level_handle);
            let directory = handle.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let storage = storage::Storage::open(directory.join("latentmail.sqlite"))?;
            handle.manage(storage.clone());
            settings::initialize(handle, storage.clone()).map_err(std::io::Error::other)?;
            auth::initialize(handle, storage.clone()).map_err(std::io::Error::other)?;
            ai::initialize(handle, storage.clone()).map_err(std::io::Error::other)?;
            avatars::initialize(handle, storage.clone()).map_err(std::io::Error::other)?;
            let vacuum_storage = storage.clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(storage::vacuum_interval());
                loop {
                    ticker.tick().await;
                    match vacuum_storage.vacuum().await {
                        Ok(pages) => {
                            tracing::info!(target: "storage", pages, "incremental vacuum complete")
                        }
                        Err(error) => {
                            tracing::warn!(target: "storage", %error, "incremental vacuum failed")
                        }
                    }
                }
            });
            sync::initialize(handle, storage).map_err(std::io::Error::other)?;
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
