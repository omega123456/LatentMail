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
pub use runtime::run;

#[cfg(not(coverage))]
mod runtime {
    use tauri::Manager;

    use crate::{
        ai, auth, avatars, cli, http_client, inline_images, ipc, logging, os, remote_images,
        settings, shell, storage, sync,
    };

    #[cfg(windows)]
    fn attach_parent_console() {
        use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};

        unsafe {
            let _ = AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }

    #[cfg(not(windows))]
    fn attach_parent_console() {}

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
            .on_window_event(handle_window_event)
            .build(tauri::generate_context!())
            .expect("error while running LatentMail")
            .run(handle_run_event);
    }

    fn handle_window_event<R: tauri::Runtime>(
        window: &tauri::Window<R>,
        event: &tauri::WindowEvent,
    ) {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            os::window::on_close(window, event);
        }
    }

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

    async fn run_vacuum_step(storage: &storage::Storage) {
        match storage.vacuum().await {
            Ok(pages) => {
                tracing::info!(target: "storage", pages, "incremental vacuum complete");
            }
            Err(error) => {
                tracing::warn!(target: "storage", %error, "incremental vacuum failed");
            }
        }
    }

    async fn vacuum_loop(storage: storage::Storage) {
        let mut ticker = tokio::time::interval(storage::vacuum_interval());
        loop {
            ticker.tick().await;
            run_vacuum_step(&storage).await;
        }
    }

    fn spawn_vacuum_loop(storage: storage::Storage) {
        tauri::async_runtime::spawn(vacuum_loop(storage));
    }

    async fn respond_remote_image(
        client: reqwest::Client,
        uri: String,
        responder: tauri::UriSchemeResponder,
    ) {
        let response =
            remote_images::respond(&client, &uri, remote_images::HostScope::PublicOnly).await;
        responder.respond(response);
    }

    async fn respond_inline_image(
        storage: storage::Storage,
        uri: String,
        responder: tauri::UriSchemeResponder,
    ) {
        responder.respond(inline_images::respond(&storage, &uri).await);
    }

    fn handle_inline_image_request<R: tauri::Runtime>(
        app: tauri::UriSchemeContext<'_, R>,
        request: tauri::http::Request<Vec<u8>>,
        responder: tauri::UriSchemeResponder,
    ) {
        let Some(storage) = app
            .app_handle()
            .try_state::<storage::Storage>()
            .map(|state| state.inner().clone())
        else {
            return;
        };
        let uri = request.uri().to_string();
        tauri::async_runtime::spawn(respond_inline_image(storage, uri, responder));
    }

    fn register_image_protocols<R: tauri::Runtime>(
        builder: tauri::Builder<R>,
        image_client: reqwest::Client,
    ) -> tauri::Builder<R> {
        builder
            .register_asynchronous_uri_scheme_protocol(
                remote_images::SCHEME,
                move |_app, request, responder| {
                    tauri::async_runtime::spawn(respond_remote_image(
                        image_client.clone(),
                        request.uri().to_string(),
                        responder,
                    ));
                },
            )
            .register_asynchronous_uri_scheme_protocol(
                inline_images::SCHEME,
                handle_inline_image_request,
            )
    }

    fn confirm_and_exit<R: tauri::Runtime>(app: &tauri::AppHandle<R>, wait: bool) {
        if wait {
            return;
        }
        app.state::<os::OsIntegration>()
            .lifecycle()
            .expect("lifecycle initialized")
            .confirm_close();
        app.exit(0);
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
            .show(move |wait| confirm_and_exit(&app, wait));
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
