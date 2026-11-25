macro_rules! string_try {
    ($result:expr) => {
        match $result {
            Ok(value) => value,
            Err(error) => return Err(error.to_string()),
        }
    };
}

pub mod ai;
pub mod app_runtime;
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

pub use http::{http_client, is_retryable_status, remote_image_client};

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
    let builder = app_runtime::register_image_protocols(
        shell::register_plugins(ipc::register(tauri::Builder::default())),
        remote_image_client(),
    );
    builder
        .setup(|app| {
            let bootstrap = app_runtime::AppBootstrap::new(app.handle()).init_logging()?;
            let storage = bootstrap.open_storage()?;
            bootstrap.init_services(storage)?;
            Ok(())
        })
        .on_window_event(app_runtime::handle_window_event)
        .build(tauri::generate_context!())
        .expect("error while running LatentMail")
        .run(app_runtime::handle_run_event);
}
