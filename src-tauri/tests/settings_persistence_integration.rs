use latentmail_lib::{
    settings::{Density, Layout, LogLevel, Settings, SettingsService, ThemePreference, WindowState},
    storage::Storage,
};
use serde_json::json;

#[tokio::test]
async fn fresh_settings_use_documented_defaults() {
    let directory = tempfile::tempdir().unwrap();
    let service =
        SettingsService::new(Storage::open(directory.path().join("mail.sqlite")).unwrap());

    assert_eq!(service.read().await.unwrap(), Settings::default());
    assert_eq!(service.read().await.unwrap().log_level, LogLevel::Info);
    assert_eq!(service.log_level(), LogLevel::Info);
}

#[tokio::test]
async fn log_level_round_trips_and_defaults_to_info() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mail.sqlite");
    let service = SettingsService::new(Storage::open(&path).unwrap());

    assert_eq!(service.log_level(), LogLevel::Info);
    service.write("logLevel".into(), json!("debug")).await.unwrap();
    assert_eq!(service.log_level(), LogLevel::Debug);
    assert_eq!(service.read().await.unwrap().log_level, LogLevel::Debug);

    let reopened = SettingsService::new(Storage::open(path).unwrap());
    assert_eq!(reopened.log_level(), LogLevel::Debug);
}

#[tokio::test]
async fn preferences_and_window_state_survive_reopening_storage() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mail.sqlite");
    let service = SettingsService::new(Storage::open(&path).unwrap());

    service.write("theme".into(), json!("dark")).await.unwrap();
    service
        .write("layout".into(), json!("list-only"))
        .await
        .unwrap();
    service
        .write("density".into(), json!("spacious"))
        .await
        .unwrap();
    service
        .write("sidebarCollapsed".into(), json!(true))
        .await
        .unwrap();
    service
        .write("sidebarWidth".into(), json!(300))
        .await
        .unwrap();
    service.write("listWidth".into(), json!(420)).await.unwrap();
    service
        .write("readerHeight".into(), json!(60))
        .await
        .unwrap();
    service
        .save_window_state(&WindowState {
            x: 12,
            y: 24,
            width: 1400,
            height: 900,
            maximized: true,
        })
        .unwrap();

    let reopened = SettingsService::new(Storage::open(path).unwrap());
    assert_eq!(
        reopened.read().await.unwrap(),
        Settings {
            theme: ThemePreference::Dark,
            layout: Layout::ListOnly,
            density: Density::Spacious,
            sidebar_collapsed: true,
            sidebar_width: 300,
            list_width: 420,
            reader_height: 60,
            ..Settings::default()
        }
    );
    assert_eq!(
        reopened.window_state().unwrap(),
        Some(WindowState {
            x: 12,
            y: 24,
            width: 1400,
            height: 900,
            maximized: true
        })
    );
}

#[tokio::test]
async fn invalid_preference_values_are_rejected_without_overwriting_the_default() {
    let directory = tempfile::tempdir().unwrap();
    let service =
        SettingsService::new(Storage::open(directory.path().join("mail.sqlite")).unwrap());

    assert!(service
        .write("layout".into(), json!("four-columns"))
        .await
        .is_err());
    assert!(service.write("unknown".into(), json!(true)).await.is_err());
    assert_eq!(service.read().await.unwrap().layout, Layout::ThreeColumn);
}

#[tokio::test]
async fn remote_image_preferences_round_trip_and_reject_a_malformed_sender_list() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mail.sqlite");
    let service = SettingsService::new(Storage::open(&path).unwrap());

    assert!(!service.read().await.unwrap().always_load_remote_images);
    assert!(service
        .read()
        .await
        .unwrap()
        .allowed_image_senders
        .is_empty());

    service
        .write("alwaysLoadRemoteImages".into(), json!(true))
        .await
        .unwrap();
    service
        .write(
            "allowedImageSenders".into(),
            json!(["receipts@stripe.com", "team@linear.app"]),
        )
        .await
        .unwrap();
    assert!(service
        .write("allowedImageSenders".into(), json!("receipts@stripe.com"))
        .await
        .is_err());

    let reopened = SettingsService::new(Storage::open(path).unwrap());
    let settings = reopened.read().await.unwrap();
    assert!(settings.always_load_remote_images);
    assert_eq!(
        settings.allowed_image_senders,
        vec!["receipts@stripe.com".to_owned(), "team@linear.app".to_owned()]
    );
}
