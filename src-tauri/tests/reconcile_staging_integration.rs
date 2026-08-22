use latentmail_lib::storage::{
    reconcile_staging::ReconcileStagingRepository, Account, AccountRepository, HtmlPresence,
    LabelRepository, Message, MessageRepository, Storage, TraversalCursor, TraversalKind,
};
use latentmail_lib::{
    gmail::GmailClient,
    sync::{create_queue_engine, noop_event_sink, SyncEngine, WorkRegistry},
};
use wiremock::{
    matchers::{method, path, query_param, query_param_is_missing},
    Mock, MockServer, ResponseTemplate,
};

fn cursor(position: &str) -> TraversalCursor {
    TraversalCursor {
        account_id: "account".into(),
        kind: TraversalKind::Reconciliation,
        position: Some(position.into()),
        discovered_count: 2,
        persisted_count: 0,
        completed: false,
        last_advanced_at: 1,
        resumed: false,
    }
}

fn response(status: u16) -> ResponseTemplate {
    ResponseTemplate::new(status).insert_header("connection", "close")
}

pub fn staging_pages_and_cursor_are_atomic_and_clear_after_completion() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "me@example.com".into(),
            display_name: String::new(),
            avatar_url: None,
            history_id: Some(1),
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    let initial = cursor("50|universe|");
    ReconcileStagingRepository::begin(&connection, &initial).unwrap();
    let next = cursor("50|label|INBOX|");
    ReconcileStagingRepository::stage_universe_page(
        &connection,
        "account",
        &["one".into(), "two".into()],
        &next,
    )
    .unwrap();
    assert_eq!(
        ReconcileStagingRepository::counts(&connection, "account").unwrap(),
        (2, 0)
    );
    assert_eq!(
        ReconcileStagingRepository::reconciliation_cursor(&connection, "account")
            .unwrap()
            .unwrap()
            .position,
        next.position
    );
    ReconcileStagingRepository::stage_label_page(
        &connection,
        "account",
        "INBOX",
        &["one".into()],
        &next,
    )
    .unwrap();
    assert_eq!(
        ReconcileStagingRepository::labels_for_message(&connection, "account", "one").unwrap(),
        ["INBOX"]
    );
    assert_eq!(
        ReconcileStagingRepository::new_message_ids(&connection, "account", None).unwrap(),
        ["one", "two"]
    );
    let foreign_keys = connection
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(foreign_keys.is_empty());
    ReconcileStagingRepository::clear(&connection, "account").unwrap();
    assert_eq!(
        ReconcileStagingRepository::counts(&connection, "account").unwrap(),
        (0, 0)
    );
}

pub fn membership_diff_reports_every_divergent_label_set() {
    let (storage, _directory) = synced_storage();
    let connection = storage.connection().unwrap();
    let staged = [
        ("added", vec!["INBOX"], vec!["INBOX", "UNREAD"]),
        ("removed", vec!["INBOX", "UNREAD"], vec!["INBOX"]),
        ("swapped", vec!["INBOX"], vec!["STARRED"]),
        ("emptied", vec!["INBOX"], vec![]),
        ("filled", vec![], vec!["INBOX"]),
        (
            "unchanged",
            vec!["INBOX", "UNREAD"],
            vec!["UNREAD", "INBOX"],
        ),
    ];
    let cursor = cursor("50|universe|");
    ReconcileStagingRepository::begin(&connection, &cursor).unwrap();
    for (id, local, remote) in &staged {
        MessageRepository::write_full_state(&connection, &stored_message(id)).unwrap();
        for label_id in local {
            LabelRepository::ensure_placeholder(&connection, "account", label_id).unwrap();
            MessageRepository::set_label_membership(&connection, "account", id, label_id, true)
                .unwrap();
        }
        ReconcileStagingRepository::stage_universe_page(
            &connection,
            "account",
            &[(*id).to_owned()],
            &cursor,
        )
        .unwrap();
        for label_id in remote {
            ReconcileStagingRepository::stage_label_page(
                &connection,
                "account",
                label_id,
                &[(*id).to_owned()],
                &cursor,
            )
            .unwrap();
        }
    }

    assert_eq!(
        ReconcileStagingRepository::membership_message_ids(&connection, "account", None).unwrap(),
        ["added", "emptied", "filled", "removed", "swapped"]
    );
    assert_eq!(
        ReconcileStagingRepository::membership_message_ids(&connection, "account", Some("emptied"))
            .unwrap(),
        ["filled", "removed", "swapped"]
    );
}

fn synced_storage() -> (Storage, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "me@example.com".into(),
            display_name: String::new(),
            avatar_url: None,
            history_id: Some(1),
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    (storage, directory)
}

async fn mount_message(server: &MockServer, id: &str) {
    Mock::given(method("GET"))
        .and(path(format!("/users/me/messages/{id}")))
        .respond_with(response(200).set_body_json(serde_json::json!({"id":id,"threadId":format!("thread-{id}"),"historyId":"50","labelIds":[],"internalDate":"1000","payload":{"headers":[]}})))
        .mount(server)
        .await;
}

fn stored_message(id: &str) -> Message {
    Message {
        account_id: "account".into(),
        id: id.into(),
        thread_id: format!("thread-{id}"),
        rfc_message_id: None,
        sender: "sender@example.com".into(),
        recipients: "me@example.com".into(),
        subject: id.into(),
        sent_at: 1,
        snippet: String::new(),
        html_body: None,
        plain_body: None,
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id: 50,
        truncated_body: None,
        html_presence: HtmlPresence::NeverFetched,
    }
}

async fn fresh_reconciliation_checkpoint_survives_interruption(previous: TraversalCursor) {
    let server = MockServer::start().await;
    let (storage, _directory) = synced_storage();
    ReconcileStagingRepository::begin(&storage.connection().unwrap(), &previous).unwrap();
    ReconcileStagingRepository::stage_universe_page(
        &storage.connection().unwrap(),
        "account",
        &["stale".into()],
        &previous,
    )
    .unwrap();
    MessageRepository::write_full_state(&storage.connection().unwrap(), &stored_message("stale"))
        .unwrap();
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(response(404))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(response(200).set_body_json(serde_json::json!({
            "emailAddress":"me@example.com",
            "messagesTotal":1,
            "threadsTotal":1,
            "historyId":"100"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(response(200).set_body_json(serde_json::json!({"labels":[]})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(response(200).set_body_json(
            serde_json::json!({"messages":[{"id":"fresh","threadId":"thread-fresh"}]}),
        ))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/fresh"))
        .respond_with(response(400))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    mount_message(&server, "fresh").await;
    assert!(
        run_reconciliation(&storage, GmailClient::with_base_url("token", server.uri()))
            .await
            .is_err()
    );
    let connection = storage.connection().unwrap();
    let saved = ReconcileStagingRepository::reconciliation_cursor(&connection, "account")
        .unwrap()
        .unwrap();
    assert_eq!(saved.position.as_deref(), Some("100|fetch|"));
    assert!(!saved.completed);
    assert_eq!(saved.discovered_count, 1);
    assert_eq!(saved.persisted_count, 0);
    assert_eq!(
        ReconcileStagingRepository::new_message_ids(&connection, "account", None).unwrap(),
        ["fresh"]
    );
    drop(connection);
    run_reconciliation(&storage, GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();
    let connection = storage.connection().unwrap();
    assert!(MessageRepository::get(&connection, "account", "fresh")
        .unwrap()
        .is_some());
    assert!(MessageRepository::get(&connection, "account", "stale")
        .unwrap()
        .is_none());
    assert_eq!(
        AccountRepository::get(&connection, "account")
            .unwrap()
            .unwrap()
            .history_id,
        Some(100)
    );
    assert!(
        ReconcileStagingRepository::reconciliation_cursor(&connection, "account")
            .unwrap()
            .unwrap()
            .completed
    );
}

async fn run_reconciliation(storage: &Storage, client: GmailClient) -> Result<(), String> {
    engine(storage.clone())
        .run_sync("account", client)
        .await
        .map_err(|error| error.to_string())
}

fn engine(storage: Storage) -> std::sync::Arc<SyncEngine> {
    let registry = WorkRegistry::new();
    SyncEngine::new(
        storage,
        create_queue_engine(250, 250, registry.clone()),
        registry,
        noop_event_sink(),
    )
}

pub async fn completed_reconciliation_cursor_starts_a_fresh_resumable_run() {
    let mut previous = cursor("50|fetch|stale");
    previous.completed = true;
    fresh_reconciliation_checkpoint_survives_interruption(previous).await;
}

pub async fn malformed_reconciliation_cursor_starts_a_fresh_resumable_run() {
    fresh_reconciliation_checkpoint_survives_interruption(cursor("malformed")).await;
}

pub async fn reconciliation_resumes_universe_enumeration_with_its_saved_candidate() {
    let server = MockServer::start().await;
    let (storage, _directory) = synced_storage();
    let initial = cursor("50|universe|");
    let resumed = cursor("50|universe|next");
    ReconcileStagingRepository::begin(&storage.connection().unwrap(), &initial).unwrap();
    ReconcileStagingRepository::stage_universe_page(
        &storage.connection().unwrap(),
        "account",
        &["one".into()],
        &resumed,
    )
    .unwrap();
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(response(404))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(response(200).set_body_json(serde_json::json!({"labels":[]})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("pageToken", "next"))
        .respond_with(
            response(200).set_body_json(
                serde_json::json!({"messages":[{"id":"two","threadId":"thread-two"}]}),
            ),
        )
        .mount(&server)
        .await;
    mount_message(&server, "one").await;
    mount_message(&server, "two").await;
    run_reconciliation(&storage, GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();
    let connection = storage.connection().unwrap();
    assert!(MessageRepository::get(&connection, "account", "one")
        .unwrap()
        .is_some());
    assert!(MessageRepository::get(&connection, "account", "two")
        .unwrap()
        .is_some());
    assert!(
        ReconcileStagingRepository::reconciliation_cursor(&connection, "account")
            .unwrap()
            .unwrap()
            .completed
    );
}

pub async fn resumed_reconciliation_matches_an_uninterrupted_universe_pass() {
    let resumed_server = MockServer::start().await;
    let uninterrupted_server = MockServer::start().await;
    let (resumed_storage, _resumed_directory) = synced_storage();
    let (uninterrupted_storage, _uninterrupted_directory) = synced_storage();
    let initial = cursor("50|universe|");
    let resumed = cursor("50|universe|next");
    ReconcileStagingRepository::begin(&resumed_storage.connection().unwrap(), &initial).unwrap();
    ReconcileStagingRepository::stage_universe_page(
        &resumed_storage.connection().unwrap(),
        "account",
        &["one".into()],
        &resumed,
    )
    .unwrap();

    for server in [&resumed_server, &uninterrupted_server] {
        Mock::given(method("GET"))
            .and(path("/users/me/history"))
            .respond_with(response(404))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/users/me/labels"))
            .respond_with(response(200).set_body_json(serde_json::json!({"labels":[]})))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/users/me/messages"))
            .and(query_param("pageToken", "next"))
            .respond_with(response(200).set_body_json(
                serde_json::json!({"messages":[{"id":"two","threadId":"thread-two"}]}),
            ))
            .mount(server)
            .await;
        mount_message(server, "one").await;
        mount_message(server, "two").await;
    }
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(response(200).set_body_json(serde_json::json!({
            "emailAddress":"me@example.com",
            "messagesTotal":2,
            "threadsTotal":2,
            "historyId":"50"
        })))
        .mount(&uninterrupted_server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("pageToken"))
        .respond_with(response(200).set_body_json(serde_json::json!({
            "messages":[{"id":"one","threadId":"thread-one"}],
            "nextPageToken":"next"
        })))
        .mount(&uninterrupted_server)
        .await;

    run_reconciliation(
        &resumed_storage,
        GmailClient::with_base_url("token", resumed_server.uri()),
    )
    .await
    .unwrap();
    run_reconciliation(
        &uninterrupted_storage,
        GmailClient::with_base_url("token", uninterrupted_server.uri()),
    )
    .await
    .unwrap();

    for storage in [&resumed_storage, &uninterrupted_storage] {
        let connection = storage.connection().unwrap();
        assert!(MessageRepository::get(&connection, "account", "one")
            .unwrap()
            .is_some());
        assert!(MessageRepository::get(&connection, "account", "two")
            .unwrap()
            .is_some());
        assert!(
            ReconcileStagingRepository::reconciliation_cursor(&connection, "account")
                .unwrap()
                .unwrap()
                .completed
        );
    }
}

pub async fn reconciliation_resumes_label_enumeration_from_its_saved_page() {
    let server = MockServer::start().await;
    let (storage, _directory) = synced_storage();
    let initial = cursor("50|universe|");
    let resumed = cursor("50|label|INBOX|next");
    ReconcileStagingRepository::begin(&storage.connection().unwrap(), &initial).unwrap();
    ReconcileStagingRepository::stage_universe_page(
        &storage.connection().unwrap(),
        "account",
        &["one".into(), "two".into()],
        &initial,
    )
    .unwrap();
    ReconcileStagingRepository::stage_label_page(
        &storage.connection().unwrap(),
        "account",
        "INBOX",
        &["one".into()],
        &resumed,
    )
    .unwrap();
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(response(404))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(response(200).set_body_json(
            serde_json::json!({"labels":[{"id":"INBOX","name":"Inbox","type":"system"}]}),
        ))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("labelIds", "INBOX"))
        .and(query_param("pageToken", "next"))
        .respond_with(
            response(200).set_body_json(
                serde_json::json!({"messages":[{"id":"two","threadId":"thread-two"}]}),
            ),
        )
        .mount(&server)
        .await;
    mount_message(&server, "one").await;
    mount_message(&server, "two").await;
    run_reconciliation(&storage, GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();
    let connection = storage.connection().unwrap();
    assert_eq!(
        MessageRepository::label_ids(&connection, "account", "one").unwrap(),
        ["INBOX"]
    );
    assert_eq!(
        MessageRepository::label_ids(&connection, "account", "two").unwrap(),
        ["INBOX"]
    );
}

pub async fn reconciliation_resumes_new_message_fetching_from_its_saved_cursor() {
    let server = MockServer::start().await;
    let (storage, _directory) = synced_storage();
    let initial = cursor("50|universe|");
    let resumed = cursor("50|fetch|one");
    ReconcileStagingRepository::begin(&storage.connection().unwrap(), &initial).unwrap();
    ReconcileStagingRepository::stage_universe_page(
        &storage.connection().unwrap(),
        "account",
        &["one".into(), "two".into()],
        &resumed,
    )
    .unwrap();
    MessageRepository::write_full_state(
        &storage.connection().unwrap(),
        &Message {
            account_id: "account".into(),
            id: "one".into(),
            thread_id: "thread-one".into(),
            rfc_message_id: None,
            sender: "sender@example.com".into(),
            recipients: "me@example.com".into(),
            subject: "one".into(),
            sent_at: 1,
            snippet: String::new(),
            html_body: None,
            plain_body: None,
            has_attachments: false,
            is_unread: false,
            is_starred: false,
            history_id: 50,
            truncated_body: None,
            html_presence: HtmlPresence::NeverFetched,
        },
    )
    .unwrap();
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(response(404))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(response(200).set_body_json(serde_json::json!({"labels":[]})))
        .mount(&server)
        .await;
    mount_message(&server, "two").await;
    run_reconciliation(&storage, GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();
    assert!(
        MessageRepository::get(&storage.connection().unwrap(), "account", "two")
            .unwrap()
            .is_some()
    );
}

pub fn keep_cases() {
    let _ = (
        staging_pages_and_cursor_are_atomic_and_clear_after_completion,
        membership_diff_reports_every_divergent_label_set,
        completed_reconciliation_cursor_starts_a_fresh_resumable_run,
        malformed_reconciliation_cursor_starts_a_fresh_resumable_run,
        reconciliation_resumes_universe_enumeration_with_its_saved_candidate,
        resumed_reconciliation_matches_an_uninterrupted_universe_pass,
        reconciliation_resumes_label_enumeration_from_its_saved_page,
        reconciliation_resumes_new_message_fetching_from_its_saved_cursor,
    );
}

#[test]
fn cases_remain_linked() {
    keep_cases();
}
