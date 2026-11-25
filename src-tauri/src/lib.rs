macro_rules! string_try {
    ($result:expr) => {
        match $result {
            Ok(value) => value,
            Err(error) => return Err(error.to_string()),
        }
    };
}

pub mod ai;
pub mod attachments;
pub mod auth;
pub mod avatars;
pub mod cli;
pub mod compose;
pub mod contacts;
pub mod date_formats;
pub mod events;
pub mod gmail;
pub mod http;
pub mod image_scheme;
pub mod inline_images;
pub mod ipc;
pub mod keychain;
pub mod logging;
pub mod message_export;
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

pub use http::{http_client, is_retryable_status};

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
    if let Some(outcome) = cli::run_client(&std::env::args().collect::<Vec<_>>()) {
        attach_parent_console();
        println!("{}", outcome.message);
        std::process::exit(outcome.exit_code);
    }
    let builder = register_image_protocols(
        shell::register_plugins(ipc::register(tauri::Builder::default())),
        http_client(),
    );
    builder
        .setup(|app| {
            let bootstrap = AppBootstrap::new(app.handle()).init_logging()?;
            let storage = bootstrap.open_storage()?;
            bootstrap.init_services(storage)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                os::window::on_close(window, event);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running LatentMail")
        .run(handle_run_event);

    struct AppBootstrap<'a, R: tauri::Runtime> {
        handle: &'a tauri::AppHandle<R>,
    }

    impl<'a, R: tauri::Runtime> AppBootstrap<'a, R> {
        fn new(handle: &'a tauri::AppHandle<R>) -> Self {
            Self { handle: handle }
        }

        fn init_logging(self) -> Result<Self, Box<dyn std::error::Error>> {
            let directory = self.handle.path().app_log_dir()?;
            let handles = logging::init(directory)?;
            self.handle.manage(handles.guard);
            self.handle.manage(handles.level_handle);
            Ok(self)
        }

        fn open_storage(&self) -> Result<storage::Storage, Box<dyn std::error::Error>> {
            let directory = self.handle.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let storage = storage::Storage::open(directory.join("latentmail.sqlite"))?;
            self.handle.manage(storage.clone());
            Ok(storage)
        }

        fn init_services(
            self,
            storage: storage::Storage,
        ) -> Result<Self, Box<dyn std::error::Error>> {
            settings::initialize(self.handle, storage.clone()).map_err(std::io::Error::other)?;
            auth::initialize(self.handle, storage.clone()).map_err(std::io::Error::other)?;
            ai::initialize(self.handle, storage.clone()).map_err(std::io::Error::other)?;
            avatars::initialize(self.handle, storage.clone()).map_err(std::io::Error::other)?;
            spawn_vacuum_loop(storage.clone());
            sync::initialize(self.handle, storage).map_err(std::io::Error::other)?;
            cli::start(self.handle);
            os::initialize(self.handle).map_err(std::io::Error::other)?;
            Ok(self)
        }
    }

    fn spawn_vacuum_loop(storage: storage::Storage) {
        tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(storage::vacuum_interval());
            loop {
                ticker.tick().await;
                match storage.vacuum().await {
                    Ok(pages) => {
                        tracing::info!(target: "storage", pages, "incremental vacuum complete")
                    }
                    Err(error) => {
                        tracing::warn!(target: "storage", %error, "incremental vacuum failed")
                    }
                }
            }
        });
    }

    fn register_image_protocols<R: tauri::Runtime>(
        builder: tauri::Builder<R>,
        image_client: reqwest::Client,
    ) -> tauri::Builder<R> {
        builder
            .register_asynchronous_uri_scheme_protocol(
                remote_images::SCHEME,
                move |_app, request, responder| {
                    let client = image_client.clone();
                    let uri = request.uri().to_string();
                    tauri::async_runtime::spawn(async move {
                        responder.respond(
                            remote_images::respond(
                                &client,
                                &uri,
                                remote_images::HostScope::PublicOnly,
                            )
                            .await,
                        );
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
    }

    fn handle_exit_requested<R: tauri::Runtime>(
        handle: &tauri::AppHandle<R>,
        code: Option<i32>,
        api: tauri::ExitRequestApi,
    ) {
        os::window::save_geometry(handle);
        let Some(lifecycle) = handle.state::<os::OsIntegration>().lifecycle().cloned() else {
            return;
        };
        let os::lifecycle::ExitDecision::Confirm { message, .. } =
            lifecycle.exit_decision(code == Some(tauri::RESTART_EXIT_CODE))
        else {
            return;
        };
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

    fn handle_run_event<R: tauri::Runtime>(handle: &tauri::AppHandle<R>, event: tauri::RunEvent) {
        match event {
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                handle_exit_requested(handle, code, api)
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => os::window::on_reopen(handle, has_visible_windows),
            _ => {}
        }
    }
}
