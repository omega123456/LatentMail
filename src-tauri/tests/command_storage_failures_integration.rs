use std::sync::Arc;

use latentmail_lib::{
    attachments::{commands::ensure_attachment_cached, AttachmentCache},
    auth::{save_refresh_token, AuthService},
    compose::staging::Staging,
    queue::commands::{retry_failed_operations, retry_queue_operation},
    search::{search_threads, search_total},
    settings::{write_setting, SettingsService},
    storage::{Account, AccountRepository, Storage},
    sync::{
        commands::{discard_compose_draft, read_traversal_status},
        create_queue_engine, noop_event_sink, SyncEngine, WorkRegistry,
    },
};
use tauri::Manager;

fn account() -> Account {
    Account {
        id: "account".into(),
        email: "account@example.com".into(),
        display_name: "Account".into(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}

struct Harness {
    app: tauri::App<tauri::test::MockRuntime>,
    database: std::path::PathBuf,
    _directory: tempfile::TempDir,
}

fn harness() -> Harness {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("mail.sqlite");
    let storage = Storage::open(&database).unwrap();
    AccountRepository::upsert(&storage.connection().unwrap(), &account()).unwrap();
    let registry = WorkRegistry::new();
    let queue = create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(
        storage.clone(),
        Arc::clone(&queue),
        registry,
        noop_event_sink(),
    );
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(SettingsService::new(storage.clone()));
    app.manage(AuthService::new(storage.clone()));
    app.manage(AttachmentCache::new(directory.path().join("attachments")).unwrap());
    app.manage(Arc::new(Staging::new(directory.path().join("staged"))));
    app.manage(engine);
    app.manage(storage);
    app.manage(queue);
    Harness {
        app,
        database,
        _directory: directory,
    }
}

impl Harness {
    fn corrupt(&self) {
        std::fs::write(&self.database, b"this is not a database").unwrap();
    }
}

fn overlong_query() -> String {
    "a".repeat(2049)
}

#[tokio::test]
async fn search_commands_reject_an_overlong_query() {
    let harness = harness();
    let app = &harness.app;

    assert_eq!(
        search_threads(
            app.state(),
            "account".into(),
            overlong_query(),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap_err(),
        "search query exceeds 2048 characters"
    );
    assert_eq!(
        search_total(app.state(), "account".into(), overlong_query(), None)
            .await
            .unwrap_err(),
        "search query exceeds 2048 characters"
    );
}

#[tokio::test]
async fn search_commands_surface_an_unreadable_database() {
    let harness = harness();
    let app = &harness.app;
    harness.corrupt();

    assert!(search_threads(
        app.state(),
        "account".into(),
        "invoice".into(),
        None,
        None,
        None,
        None,
    )
    .await
    .is_err());
    assert!(
        search_total(app.state(), "account".into(), "invoice".into(), None)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn writing_start_at_login_rejects_a_non_boolean_value() {
    let harness = harness();
    let app = &harness.app;

    assert_eq!(
        write_setting(
            app.handle().clone(),
            app.state(),
            "startAtLogin".into(),
            serde_json::json!("yes"),
        )
        .await
        .unwrap_err(),
        "Unknown or invalid setting: startAtLogin"
    );
}

#[tokio::test]
async fn queue_commands_surface_an_unreadable_database() {
    let harness = harness();
    let app = &harness.app;
    harness.corrupt();

    assert!(
        retry_queue_operation(app.state(), app.state(), "operation".into())
            .await
            .is_err()
    );
    assert!(retry_failed_operations(app.state(), app.state(), None)
        .await
        .is_err());
}

#[tokio::test]
async fn reading_traversal_status_surfaces_an_unreadable_database() {
    let harness = harness();
    let app = &harness.app;
    harness.corrupt();

    assert!(read_traversal_status(app.state(), "account".into())
        .await
        .is_err());
}

#[tokio::test]
async fn caching_an_attachment_surfaces_an_unreadable_database() {
    let harness = harness();
    let app = &harness.app;
    save_refresh_token("account", "refresh").unwrap();
    harness.corrupt();

    assert!(ensure_attachment_cached(
        app.handle().clone(),
        app.state(),
        app.state(),
        app.state(),
        app.state(),
        "account".into(),
        "message-1".into(),
        "attachment-1".into(),
    )
    .await
    .is_err());
}

#[tokio::test]
async fn discarding_a_compose_draft_surfaces_an_unreadable_database() {
    let harness = harness();
    let app = &harness.app;
    harness.corrupt();

    assert!(discard_compose_draft(
        app.handle().clone(),
        app.state(),
        app.state(),
        app.state(),
        app.state(),
        "account".into(),
        None,
        "session-1".into(),
    )
    .await
    .is_err());
}
