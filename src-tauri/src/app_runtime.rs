use std::path::Path;

use tauri::Manager;

use crate::{
    ai, auth, avatars, cli, inline_images, logging, os, remote_images, settings, storage, sync,
};

const DATABASE_FILE_NAME: &str = "latentmail.sqlite";

pub struct AppBootstrap<'a, R: tauri::Runtime> {
    handle: &'a tauri::AppHandle<R>,
}

impl<'a, R: tauri::Runtime> AppBootstrap<'a, R> {
    pub fn new(handle: &'a tauri::AppHandle<R>) -> Self {
        Self { handle: handle }
    }

    pub fn init_logging(self) -> Result<Self, Box<dyn std::error::Error>> {
        let directory = self.handle.path().app_log_dir()?;
        let handles = logging::init(directory)?;
        self.handle.manage(handles.guard);
        self.handle.manage(handles.level_handle);
        Ok(self)
    }

    pub fn open_storage(&self) -> Result<storage::Storage, Box<dyn std::error::Error>> {
        let directory = self.handle.path().app_data_dir()?;
        let storage = open_storage_in(&directory)?;
        self.handle.manage(storage.clone());
        Ok(storage)
    }

    pub fn init_services(
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

pub fn open_storage_in(directory: &Path) -> Result<storage::Storage, Box<dyn std::error::Error>> {
    std::fs::create_dir_all(directory)?;
    Ok(storage::Storage::open(directory.join(DATABASE_FILE_NAME))?)
}

pub async fn run_vacuum_step(storage: &storage::Storage) {
    match storage.vacuum().await {
        Ok(pages) => {
            tracing::info!(target: "storage", pages, "incremental vacuum complete");
        }
        Err(error) => {
            tracing::warn!(target: "storage", %error, "incremental vacuum failed");
        }
    }
}

pub async fn vacuum_loop(storage: storage::Storage) {
    let mut ticker = tokio::time::interval(storage::vacuum_interval());
    loop {
        ticker.tick().await;
        run_vacuum_step(&storage).await;
    }
}

pub fn spawn_vacuum_loop(storage: storage::Storage) {
    tauri::async_runtime::spawn(vacuum_loop(storage));
}

pub async fn respond_remote_image(
    client: reqwest::Client,
    uri: String,
    responder: tauri::UriSchemeResponder,
) {
    let response =
        remote_images::respond(&client, &uri, remote_images::HostScope::PublicOnly).await;
    responder.respond(response);
}

pub async fn respond_inline_image(
    storage: storage::Storage,
    uri: String,
    responder: tauri::UriSchemeResponder,
) {
    responder.respond(inline_images::respond(&storage, &uri).await);
}

pub fn handle_inline_image_request<R: tauri::Runtime>(
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

pub fn register_image_protocols<R: tauri::Runtime>(
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

pub fn handle_window_event<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    event: &tauri::WindowEvent,
) {
    if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
        os::window::on_close(window, event);
    }
}

pub fn confirm_and_exit<R: tauri::Runtime>(app: &tauri::AppHandle<R>, wait: bool) {
    if wait {
        return;
    }
    app.state::<os::OsIntegration>()
        .lifecycle()
        .expect("lifecycle initialized")
        .confirm_close();
    app.exit(0);
}

pub fn exit_confirmation_message<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
    code: Option<i32>,
) -> Option<String> {
    let integration = handle.try_state::<os::OsIntegration>()?;
    let lifecycle = integration.lifecycle()?;
    let is_restart = code == Some(tauri::RESTART_EXIT_CODE);
    let os::lifecycle::ExitDecision::Confirm { message, .. } = lifecycle.exit_decision(is_restart)
    else {
        return None;
    };
    Some(message)
}

pub fn handle_exit_requested<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
    code: Option<i32>,
    api: tauri::ExitRequestApi,
) {
    os::window::save_geometry(handle);
    let Some(message) = exit_confirmation_message(handle, code) else {
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

pub fn handle_run_event<R: tauri::Runtime>(handle: &tauri::AppHandle<R>, event: tauri::RunEvent) {
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
