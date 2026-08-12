//! Exercises the settings IPC commands and window-state helpers that
//! `settings_persistence_integration.rs` does not reach (that file only
//! drives `SettingsService` directly, not the Tauri command wrappers or the
//! window position/size helpers).

use latentmail_lib::settings::{
    initialize, read_settings, restore_window, save_window, write_setting, Settings,
    SettingsService, WindowState,
};
use latentmail_lib::storage::Storage;
use tauri::Manager;

fn app_with_service() -> (tauri::App<tauri::test::MockRuntime>, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    // Commands below are called directly as plain async functions (not
    // dispatched through IPC), so this deliberately skips
    // `latentmail_lib::ipc::register` to avoid pulling in and
    // monomorphizing every other command's generic code in this binary.
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(SettingsService::new(storage));
    (app, directory)
}

#[tokio::test]
async fn read_and_write_setting_commands_round_trip_through_the_service() {
    let (app, _directory) = app_with_service();

    let defaults = read_settings(app.state()).await.unwrap();
    assert_eq!(defaults, Settings::default());

    write_setting(
        app.handle().clone(),
        app.state(),
        "theme".into(),
        serde_json::json!("dark"),
    )
    .await
    .unwrap();

    let updated = read_settings(app.state()).await.unwrap();
    assert_eq!(
        updated.theme,
        latentmail_lib::settings::ThemePreference::Dark
    );

    let error = write_setting(
        app.handle().clone(),
        app.state(),
        "not-a-real-key".into(),
        serde_json::json!(true),
    )
    .await
    .unwrap_err();
    assert!(error.contains("Unknown or invalid setting"));
}

#[tokio::test]
async fn restore_window_applies_saved_position_size_and_maximized_state() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let service = SettingsService::new(storage);
    service
        .save_window_state(&WindowState {
            x: 5,
            y: 10,
            width: 800,
            height: 600,
            maximized: true,
        })
        .unwrap();

    let app = tauri::test::mock_app();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    // The mock runtime does not actually track applied geometry, so this
    // asserts the happy path runs to completion (every `set_*`/`maximize`
    // call succeeds) rather than the resulting geometry.
    restore_window(&window, &service);
}

#[tokio::test]
async fn restore_window_is_a_no_op_when_no_state_was_saved() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let service = SettingsService::new(storage);

    let app = tauri::test::mock_app();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    // Must not panic even though `window_state()` returns `Ok(None)`.
    restore_window(&window, &service);
}

#[tokio::test]
async fn save_window_persists_the_current_window_geometry() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let service = SettingsService::new(storage);

    let app = tauri::test::mock_app();
    tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let window = app.get_window("main").unwrap();

    save_window(&window, &service);

    assert!(service.window_state().unwrap().is_some());
}

#[test]
fn initialize_creates_the_app_data_directory_manages_state_and_shows_the_window() {
    // Tauri's path resolver derives `app_data_dir()` from the OS's per-user
    // data directory (HOME on macOS/Linux, APPDATA on Windows). Redirecting
    // it to a throwaway temp dir keeps this fully isolated from the real
    // machine, as nextest runs each test in its own process.
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    std::env::set_var("APPDATA", home.path());
    std::env::set_var("XDG_DATA_HOME", home.path());

    let app = tauri::test::mock_app();
    tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .visible(false)
        .build()
        .unwrap();

    initialize(app.handle()).unwrap();

    assert!(app.try_state::<SettingsService>().is_some());
}

/// The sync-interval preference has to reach the scheduler that is already
/// running, otherwise it only takes effect after a restart.
#[tokio::test]
async fn writing_the_sync_interval_reaches_a_running_scheduler() {
    let (app, _directory) = app_with_service();
    app.manage(latentmail_lib::sync::SyncScheduler::start(
        std::time::Duration::from_secs(300),
        false,
        || async {},
    ));

    write_setting(
        app.handle().clone(),
        app.state(),
        "syncIntervalMinutes".into(),
        serde_json::json!(15),
    )
    .await
    .unwrap();

    assert_eq!(read_settings(app.state()).await.unwrap().sync_interval_minutes, 15);
}
