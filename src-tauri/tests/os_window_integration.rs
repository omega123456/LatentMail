use latentmail_lib::{
    os::window::{
        close_action, on_close, on_reopen, save_geometry, should_show_on_startup, show_and_focus,
        CloseAction,
    },
    settings::{SettingsService, WindowState},
    storage::Storage,
};
use tauri::Manager;

#[test]
fn startup_hides_only_for_the_enabled_windows_combination() {
    assert!(!should_show_on_startup(true, true, true));
    assert!(should_show_on_startup(false, true, true));
    assert!(should_show_on_startup(true, false, true));
    assert!(should_show_on_startup(true, true, false));
}

#[tokio::test]
async fn closing_decides_between_hiding_and_termination_after_geometry_is_persisted() {
    let directory = tempfile::tempdir().unwrap();
    let service =
        SettingsService::new(Storage::open(directory.path().join("mail.sqlite")).unwrap());
    let state = WindowState {
        x: 12,
        y: 34,
        width: 1200,
        height: 800,
        maximized: false,
    };
    for (close_to_tray, windows, action) in [
        (true, true, CloseAction::Hide),
        (false, true, CloseAction::Terminate),
        (true, false, CloseAction::Terminate),
        (false, false, CloseAction::Terminate),
    ] {
        service.save_window_state(&state).unwrap();
        assert_eq!(close_action(close_to_tray, windows, false), action);
        assert_eq!(service.window_state().unwrap(), Some(state.clone()));
    }
}

#[test]
fn macos_closing_hides_regardless_of_the_windows_preference() {
    assert_eq!(close_action(false, false, true), CloseAction::Hide);
    assert_eq!(close_action(true, false, true), CloseAction::Hide);
}

#[test]
fn showing_a_mock_app_window_is_safe() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();

    show_and_focus(app.handle());
    on_reopen(app.handle(), true);
    on_reopen(app.handle(), false);
}

#[tokio::test]
async fn exiting_without_a_close_request_still_persists_the_geometry() {
    let directory = tempfile::tempdir().unwrap();
    let service =
        SettingsService::new(Storage::open(directory.path().join("mail.sqlite")).unwrap());
    let app = tauri::test::mock_app();

    save_geometry(app.handle());
    assert_eq!(service.window_state().unwrap(), None);

    tauri::WebviewWindowBuilder::new(app.handle(), "main", Default::default())
        .build()
        .unwrap();
    app.manage(service);

    save_geometry(app.handle());

    assert!(app
        .state::<SettingsService>()
        .window_state()
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn window_events_persist_geometry_before_close_handling() {
    let directory = tempfile::tempdir().unwrap();
    let service =
        SettingsService::new(Storage::open(directory.path().join("mail.sqlite")).unwrap());
    let app = tauri::test::mock_app();
    app.manage(service);
    let window = tauri::WebviewWindowBuilder::new(app.handle(), "main", Default::default())
        .build()
        .unwrap();

    on_close(&window.as_ref().window(), &tauri::WindowEvent::Destroyed);

    assert!(app
        .state::<SettingsService>()
        .window_state()
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn window_preferences_default_and_read_synchronously() {
    let directory = tempfile::tempdir().unwrap();
    let service =
        SettingsService::new(Storage::open(directory.path().join("mail.sqlite")).unwrap());

    assert!(service.close_to_tray());
    assert!(!service.start_minimized());

    service
        .write("closeToTray".to_owned(), serde_json::json!(false))
        .await
        .unwrap();
    service
        .write("startMinimized".to_owned(), serde_json::json!(true))
        .await
        .unwrap();

    assert!(!service.close_to_tray());
    assert!(service.start_minimized());
}
