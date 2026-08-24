use latentmail_lib::{
    ai::{credentials, provider::ProviderError, AiConfigDto},
    storage::Storage,
};

#[test]
fn account_keys_are_isolated_and_write_only_storage_replaces_and_clears() {
    credentials::clear("account-a").unwrap();
    credentials::clear("account-b").unwrap();
    credentials::save("account-a", "first").unwrap();
    credentials::save("account-b", "second").unwrap();
    credentials::save("account-a", "replacement").unwrap();
    assert_eq!(
        credentials::load("account-a").unwrap(),
        Some("replacement".into())
    );
    assert_eq!(
        credentials::load("account-b").unwrap(),
        Some("second".into())
    );
    credentials::clear("account-a").unwrap();
    assert_eq!(credentials::load("account-a").unwrap(), None);
}

#[test]
fn keys_are_absent_from_database_payloads_and_provider_errors() {
    let key = "real-ai-api-key";
    credentials::clear("credential-account").unwrap();
    credentials::clear("other-account").unwrap();
    credentials::save("credential-account", key).unwrap();
    credentials::save("other-account", "other-ai-api-key").unwrap();
    assert_eq!(
        credentials::load("credential-account").unwrap().as_deref(),
        Some(key)
    );
    assert_eq!(
        credentials::load("other-account").unwrap().as_deref(),
        Some("other-ai-api-key")
    );
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("mail.db");
    let storage = Storage::open(&database).unwrap();
    let connection = storage.connection().unwrap();
    let schema: String = connection
        .query_row(
            "SELECT group_concat(sql, ' ') FROM sqlite_master WHERE type='table'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!schema.contains("api_key"));
    let payload = serde_json::to_string(&AiConfigDto {
        account_id: "account".into(),
        email: "mail@example.com".into(),
        display_name: "Mail".into(),
        enabled: true,
        base_url: Some("http://127.0.0.1/v1/".into()),
        chat_model: None,
        embedding_model: None,
        embedding_dimensions: None,
        has_api_key: true,
        index_paused: false,
    })
    .unwrap();
    assert!(!payload.contains(key));
    for error in [
        ProviderError::Transport,
        ProviderError::RateLimited,
        ProviderError::Server,
        ProviderError::Authentication,
        ProviderError::Response,
    ] {
        assert!(!error.to_string().contains(key));
    }
    drop(connection);
    drop(storage);
    assert!(!std::fs::read(database)
        .unwrap()
        .windows(key.len())
        .any(|bytes| bytes == key.as_bytes()));
    credentials::clear("credential-account").unwrap();
    credentials::clear("other-account").unwrap();
}
