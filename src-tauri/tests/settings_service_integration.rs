use latentmail_lib::settings::{
    initialize, read_settings, restore_window, save_window, write_setting, Settings,
    SettingsService, WindowState,
};
use latentmail_lib::storage::Storage;
use tauri::Manager;

fn app_with_service() -> (tauri::App<tauri::test::MockRuntime>, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();

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
async fn every_persisted_setting_accepts_its_wire_value() {
    let (app, _directory) = app_with_service();

    for (key, value) in [
        ("theme", serde_json::json!("light")),
        ("layout", serde_json::json!("bottom-preview")),
        ("density", serde_json::json!("spacious")),
        ("sidebarCollapsed", serde_json::json!(true)),
        ("sidebarWidth", serde_json::json!(280)),
        ("listWidth", serde_json::json!(420)),
        ("readerHeight", serde_json::json!(55)),
        ("syncOnStartup", serde_json::json!(false)),
        ("showUnreadCounts", serde_json::json!(false)),
        ("syncIntervalSeconds", serde_json::json!(45)),
        ("showSenderAvatars", serde_json::json!(false)),
        ("zoomPercent", serde_json::json!(125)),
        ("prefetchImageAttachments", serde_json::json!(true)),
    ] {
        write_setting(app.handle().clone(), app.state(), key.into(), value)
            .await
            .unwrap();
    }

    let settings = read_settings(app.state()).await.unwrap();
    assert_eq!(
        settings.theme,
        latentmail_lib::settings::ThemePreference::Light
    );
    assert_eq!(
        settings.layout,
        latentmail_lib::settings::Layout::BottomPreview
    );
    assert_eq!(
        settings.density,
        latentmail_lib::settings::Density::Spacious
    );
    assert!(settings.sidebar_collapsed);
    assert_eq!(settings.sidebar_width, 280);
    assert_eq!(settings.list_width, 420);
    assert_eq!(settings.reader_height, 55);
    assert!(!settings.sync_on_startup);
    assert!(!settings.show_unread_counts);
    assert_eq!(settings.sync_interval_seconds, 45);
    assert!(!settings.show_sender_avatars);
    assert_eq!(settings.zoom_percent, 125);
    assert!(settings.prefetch_image_attachments);
}

#[tokio::test]
async fn writing_every_log_level_persists_and_applies_it_live_without_panicking() {
    let (app, _directory) = app_with_service();

    for level in ["debug", "info", "warn", "error"] {
        write_setting(
            app.handle().clone(),
            app.state(),
            "logLevel".into(),
            serde_json::json!(level),
        )
        .await
        .unwrap();

        let settings = read_settings(app.state()).await.unwrap();
        assert_eq!(
            serde_json::to_value(&settings.log_level).unwrap(),
            serde_json::json!(level)
        );
    }
}

#[tokio::test]
async fn writing_an_invalid_log_level_value_leaves_the_persisted_setting_unchanged() {
    let (app, _directory) = app_with_service();

    let error = write_setting(
        app.handle().clone(),
        app.state(),
        "logLevel".into(),
        serde_json::json!("not-a-real-level"),
    )
    .await
    .unwrap_err();
    assert!(error.contains("Unknown or invalid setting"));

    let settings = read_settings(app.state()).await.unwrap();
    assert_eq!(settings.log_level, latentmail_lib::settings::LogLevel::Info);
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

#[tokio::test]
async fn write_surfaces_a_storage_error_when_the_settings_table_cannot_accept_an_upsert() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    {
        let connection = storage.connection().unwrap();
        connection.execute("DROP TABLE settings", []).unwrap();
        connection
            .execute(
                "CREATE TABLE settings (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, value TEXT NOT NULL)",
                [],
            )
            .unwrap();
    }
    let service = SettingsService::new(storage);

    assert!(service.read().await.is_ok());
    let error = service
        .write("theme".into(), serde_json::json!("dark"))
        .await
        .unwrap_err();
    assert!(error.to_lowercase().contains("conflict"));
}

#[test]
fn initialize_creates_the_app_data_directory_manages_state_and_shows_the_window() {
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

#[tokio::test]
async fn writing_the_sync_interval_reaches_a_running_scheduler() {
    let (app, _directory) = app_with_service();
    let periodic = latentmail_lib::sync::SyncScheduler::start(
        std::time::Duration::from_secs(300),
        false,
        || async {},
    );
    let fast = latentmail_lib::sync::SyncScheduler::start(
        std::time::Duration::from_secs(latentmail_lib::sync::FAST_PROBE_INTERVAL_SECS),
        true,
        || async {},
    );
    app.manage(latentmail_lib::sync::SyncSchedulers {
        fast: std::sync::Arc::clone(&fast),
        periodic: std::sync::Arc::clone(&periodic),
    });

    write_setting(
        app.handle().clone(),
        app.state(),
        "syncIntervalSeconds".into(),
        serde_json::json!(30),
    )
    .await
    .unwrap();

    assert_eq!(
        read_settings(app.state())
            .await
            .unwrap()
            .sync_interval_seconds,
        30
    );
    assert_eq!(periodic.interval(), std::time::Duration::from_secs(30));
    assert_eq!(
        fast.interval(),
        std::time::Duration::from_secs(latentmail_lib::sync::FAST_PROBE_INTERVAL_SECS)
    );

    write_setting(
        app.handle().clone(),
        app.state(),
        "syncIntervalSeconds".into(),
        serde_json::json!(10),
    )
    .await
    .unwrap();
    assert_eq!(periodic.interval(), std::time::Duration::from_secs(15));
    assert_eq!(
        fast.interval(),
        std::time::Duration::from_secs(latentmail_lib::sync::FAST_PROBE_INTERVAL_SECS)
    );
}

#[tokio::test]
async fn writing_the_sync_interval_without_a_managed_scheduler_still_persists() {
    let (app, _directory) = app_with_service();

    write_setting(
        app.handle().clone(),
        app.state(),
        "syncIntervalSeconds".into(),
        serde_json::json!(20),
    )
    .await
    .unwrap();

    assert_eq!(
        read_settings(app.state())
            .await
            .unwrap()
            .sync_interval_seconds,
        20
    );
}

#[tokio::test]
async fn writing_every_update_check_interval_persists_it() {
    let (app, _directory) = app_with_service();

    let defaults = read_settings(app.state()).await.unwrap();
    assert_eq!(
        defaults.update_check_interval,
        latentmail_lib::settings::UpdateCheckInterval::Daily
    );
    assert!(defaults.install_update_on_quit);

    for (wire, expected) in [
        ("1h", latentmail_lib::settings::UpdateCheckInterval::Hourly),
        ("5h", latentmail_lib::settings::UpdateCheckInterval::FiveHours),
        ("1d", latentmail_lib::settings::UpdateCheckInterval::Daily),
        ("7d", latentmail_lib::settings::UpdateCheckInterval::Weekly),
        ("off", latentmail_lib::settings::UpdateCheckInterval::Off),
    ] {
        write_setting(
            app.handle().clone(),
            app.state(),
            "updateCheckInterval".into(),
            serde_json::json!(wire),
        )
        .await
        .unwrap();

        let settings = read_settings(app.state()).await.unwrap();
        assert_eq!(settings.update_check_interval, expected);
    }

    write_setting(
        app.handle().clone(),
        app.state(),
        "installUpdateOnQuit".into(),
        serde_json::json!(false),
    )
    .await
    .unwrap();

    assert!(
        !read_settings(app.state())
            .await
            .unwrap()
            .install_update_on_quit
    );
}
