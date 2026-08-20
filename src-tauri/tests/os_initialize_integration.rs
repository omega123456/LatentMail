use latentmail_lib::{
    os::{emit_mailto, initialize, OsIntegration},
    storage::Storage,
};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Listener, Manager};

#[test]
fn initialize_manages_the_integration_under_the_mock_runtime() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();

    initialize(app.handle()).unwrap();
    initialize(app.handle()).unwrap();

    assert!(app.try_state::<OsIntegration>().is_some());
}

#[tokio::test]
async fn indicator_refreshes_from_each_domain_event_with_managed_storage() {
    let directory = tempfile::tempdir().unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(Storage::open(directory.path().join("mail.sqlite")).unwrap());
    initialize(app.handle()).unwrap();
    app.emit("mail://new", ()).unwrap();
    app.emit("queue://item", ()).unwrap();
    app.emit("account://state", ()).unwrap();
    tokio::time::sleep(chrono::Duration::milliseconds(150).to_std().unwrap()).await;
    assert!(app.try_state::<OsIntegration>().is_some());
    assert!(app.state::<OsIntegration>().indicator_applications().0 > 0);
    assert!(app.state::<OsIntegration>().indicator_applications().1 > 0);
    let (tray, badge) = app.state::<OsIntegration>().platform_state();
    assert!(tray.created);
    assert_eq!(tray.tooltip.as_deref(), Some("LatentMail — 0 unread"));
    assert_eq!(tray.menu.unwrap().rows[0], "0 unread messages");
    assert_eq!(tray.icon, None);
    assert_eq!(badge.dock_badge, Some(None));
    assert_eq!(badge.overlay, Some(None));
}

#[tokio::test]
async fn initialize_computes_the_first_indicator_without_waiting_for_an_event() {
    let directory = tempfile::tempdir().unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(Storage::open(directory.path().join("mail.sqlite")).unwrap());
    initialize(app.handle()).unwrap();
    tokio::time::sleep(chrono::Duration::milliseconds(150).to_std().unwrap()).await;
    assert_eq!(
        app.state::<OsIntegration>().indicator().await.unread_count,
        0
    );
}

#[tokio::test]
async fn mailto_waits_for_frontend_readiness_before_emitting_an_intent() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    initialize(app.handle()).unwrap();
    let received = Arc::new(Mutex::new(Vec::new()));
    let target = Arc::clone(&received);
    app.listen("os://intent", move |event| {
        target.lock().unwrap().push(event.payload().to_owned());
    });
    emit_mailto(app.handle(), "mailto:alex%40example.com?subject=Hello");
    tokio::time::sleep(chrono::Duration::milliseconds(20).to_std().unwrap()).await;
    assert!(received.lock().unwrap().is_empty());
    app.emit("frontend://ready", ()).unwrap();
    tokio::time::sleep(chrono::Duration::milliseconds(20).to_std().unwrap()).await;
    assert!(received.lock().unwrap()[0].contains("alex@example.com"));
}
