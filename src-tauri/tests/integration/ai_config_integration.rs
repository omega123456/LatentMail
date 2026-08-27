use latentmail_lib::storage::{Account, AccountAiConfigRepository, AccountRepository, Storage};

#[test]
fn account_config_is_isolated_and_foreign_keys_remain_valid() {
    let connection = Storage::in_memory().unwrap();
    for id in ["account-a", "account-b"] {
        AccountRepository::upsert(
            &connection,
            &Account {
                id: id.into(),
                email: format!("{id}@example.com"),
                display_name: id.into(),
                avatar_url: None,
                history_id: None,
                needs_reauthentication: false,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
    }
    AccountAiConfigRepository::set_base_url(&connection, "account-a", "http://localhost/v1/")
        .unwrap();
    AccountAiConfigRepository::set_embedding_model(&connection, "account-a", "embed", 3).unwrap();
    assert_eq!(
        AccountAiConfigRepository::get(&connection, "account-a")
            .unwrap()
            .unwrap()
            .embedding_dimensions,
        Some(3)
    );
    assert!(AccountAiConfigRepository::get(&connection, "account-b")
        .unwrap()
        .is_none());
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}

fn seeded_account(database: &std::path::Path) -> Storage {
    let storage = Storage::open(database).unwrap();
    AccountRepository::upsert(
        &storage.connection().unwrap(),
        &Account {
            id: "account".into(),
            email: "account@example.com".into(),
            display_name: "Account".into(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    storage
}

#[tokio::test]
async fn setting_an_embedding_model_surfaces_an_unreadable_database() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("mail.sqlite");
    let storage = seeded_account(&database);
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let service = latentmail_lib::ai::AiService::new(storage);
    std::fs::write(&database, b"not a database").unwrap();

    assert!(service
        .set_embedding_model(
            tauri::Manager::app_handle(&app),
            "account".into(),
            "embedding".into(),
            2,
        )
        .await
        .is_err());
}

#[test]
fn initializing_ai_surfaces_an_unreadable_database() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("mail.sqlite");
    let storage = seeded_account(&database);
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    std::fs::write(&database, b"not a database").unwrap();

    assert!(latentmail_lib::ai::initialize(tauri::Manager::app_handle(&app), storage).is_err());
}

#[test]
fn initializing_ai_surfaces_a_missing_config_table() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("mail.sqlite");
    let storage = seeded_account(&database);
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    storage
        .connection()
        .unwrap()
        .execute("DROP TABLE account_ai_config", [])
        .unwrap();

    assert!(latentmail_lib::ai::initialize(tauri::Manager::app_handle(&app), storage).is_err());
}

#[test]
fn initializing_ai_surfaces_a_rejected_embedding_table() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("mail.sqlite");
    let storage = seeded_account(&database);
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    {
        let connection = storage.connection().unwrap();
        AccountAiConfigRepository::set_embedding_model(&connection, "account", "embed", 0).unwrap();
    }

    assert!(latentmail_lib::ai::initialize(tauri::Manager::app_handle(&app), storage).is_err());
}
