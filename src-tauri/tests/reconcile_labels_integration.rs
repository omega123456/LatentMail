use latentmail_lib::{
    gmail::GmailClient,
    storage::{
        Account, AccountRepository, HtmlPresence, LabelRepository, Message, MessageRepository,
        Storage, Thread, ThreadIdentity, ThreadRepository,
    },
    sync::{create_queue_engine, noop_event_sink, SyncEngine, WorkRegistry},
};
use wiremock::{
    matchers::{method, path, query_param, query_param_is_missing},
    Mock, MockServer, ResponseTemplate,
};

fn temp_storage(history_id: Option<i64>) -> (Storage, tempfile::TempDir) {
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
            history_id,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    (storage, directory)
}

fn row(id: &str, thread_id: &str, subject: &str) -> Message {
    Message {
        account_id: "account".into(),
        id: id.into(),
        thread_id: thread_id.into(),
        rfc_message_id: None,
        sender: "sender@example.com".into(),
        recipients: "me@example.com".into(),
        subject: subject.into(),
        sent_at: 1,
        snippet: String::new(),
        html_body: None,
        plain_body: None,
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id: 1,
        truncated_body: None,
        html_presence: HtmlPresence::Absent,
    }
}

async fn mount_reconciliation_scaffold(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(404))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 1, "threadsTotal": 1, "historyId": "50"
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "labels": [
                {"id": "TRASH", "name": "Trash", "type": "system"},
                {"id": "STARRED", "name": "Starred", "type": "system"},
                {"id": "UNREAD", "name": "Unread", "type": "system"}
            ]
        })))
        .mount(server)
        .await;
}

#[tokio::test]
async fn starred_unread_message_in_trash_survives_reconciliation_via_the_real_pipeline() {
    let server = MockServer::start().await;
    mount_reconciliation_scaffold(&server).await;

    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("labelIds"))
        .and(query_param("includeSpamTrash", "true"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [
                {"id": "starred-trash", "threadId": "thread-1"},
                {"id": "kept", "threadId": "kept-thread"}
            ]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/starred-trash"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "starred-trash", "threadId": "thread-1", "historyId": "50",
            "labelIds": ["TRASH", "STARRED", "UNREAD"], "internalDate": "1000",
            "payload": { "headers": [{"name": "Subject", "value": "Trashed"}] }
        })))
        .mount(&server)
        .await;
    for label in ["TRASH", "STARRED", "UNREAD"] {
        Mock::given(method("GET"))
            .and(path("/users/me/messages"))
            .and(query_param("labelIds", label))
            .and(query_param("includeSpamTrash", "true"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "messages": [{"id": "starred-trash", "threadId": "thread-1"}]
            })))
            .expect(1)
            .mount(&server)
            .await;
    }

    let (storage, _directory) = temp_storage(Some(1));
    let connection = storage.connection().unwrap();
    MessageRepository::write_full_state(&connection, &row("kept", "kept-thread", "Real Subject"))
        .unwrap();
    ThreadRepository::upsert(
        &connection,
        &Thread {
            account_id: "account".into(),
            id: "kept-thread".into(),
            subject: "STALE — must not be recomputed".into(),
            participants: "sender@example.com".into(),
            latest_at: 1,
            message_count: 1,
            is_unread: false,
            is_starred: false,
            has_attachments: false,
            has_draft: false,
            sender_identity: ThreadIdentity {
                display: "sender@example.com".into(),
                address: Some("sender@example.com".into()),
            },
            recipient_identity: None,
        },
    )
    .unwrap();
    drop(connection);

    let registry = WorkRegistry::new();
    let engine = SyncEngine::new(
        storage.clone(),
        create_queue_engine(250, 250, registry.clone()),
        registry,
        noop_event_sink(),
    );
    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    server.verify().await;

    let connection = storage.connection().unwrap();
    let trashed = MessageRepository::get(&connection, "account", "starred-trash")
        .unwrap()
        .unwrap();
    assert!(
        trashed.is_starred,
        "a starred message in Trash must stay starred after reconciliation"
    );
    assert!(
        trashed.is_unread,
        "an unread message in Trash must stay unread after reconciliation"
    );
    let mut labels = MessageRepository::label_ids(&connection, "account", "starred-trash").unwrap();
    labels.sort();
    assert_eq!(
        labels,
        vec![
            "STARRED".to_owned(),
            "TRASH".to_owned(),
            "UNREAD".to_owned()
        ]
    );

    let kept_thread = ThreadRepository::get(&connection, "account", "kept-thread")
        .unwrap()
        .unwrap();
    assert_eq!(
        kept_thread.subject, "STALE — must not be recomputed",
        "a thread with no membership delta must never be recomputed"
    );
}

#[tokio::test]
async fn reconciliation_failure_never_adopts_the_new_checkpoint() {
    let server = MockServer::start().await;
    mount_reconciliation_scaffold(&server).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("labelIds"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "new-message", "threadId": "new-thread"}]
        })))
        .mount(&server)
        .await;
    for label in ["TRASH", "STARRED", "UNREAD"] {
        Mock::given(method("GET"))
            .and(path("/users/me/messages"))
            .and(query_param("labelIds", label))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "messages": [] })),
            )
            .mount(&server)
            .await;
    }
    Mock::given(method("GET"))
        .and(path("/users/me/messages/new-message"))
        .respond_with(ResponseTemplate::new(403))
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage(Some(1));
    let registry = WorkRegistry::new();
    let engine = SyncEngine::new(
        storage.clone(),
        create_queue_engine(250, 250, registry.clone()),
        registry,
        noop_event_sink(),
    );

    let outcome = engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await;
    assert!(
        outcome.is_err(),
        "the fetch failure must propagate as an error"
    );

    let connection = storage.connection().unwrap();
    assert_eq!(
        AccountRepository::get(&connection, "account")
            .unwrap()
            .unwrap()
            .history_id,
        Some(1),
        "a failed reconciliation must never adopt the fresh checkpoint it read"
    );
}

#[tokio::test]
async fn progress_counts_report_the_distinct_universe_size_not_a_sum_across_labels() {
    let server = MockServer::start().await;
    mount_reconciliation_scaffold(&server).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("labelIds"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "in-every-label", "threadId": "thread-1"}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/in-every-label"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "in-every-label", "threadId": "thread-1", "historyId": "50",
            "labelIds": ["TRASH", "STARRED", "UNREAD"], "internalDate": "1000",
            "payload": { "headers": [] }
        })))
        .mount(&server)
        .await;
    for label in ["TRASH", "STARRED", "UNREAD"] {
        Mock::given(method("GET"))
            .and(path("/users/me/messages"))
            .and(query_param("labelIds", label))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "messages": [{"id": "in-every-label", "threadId": "thread-1"}]
            })))
            .mount(&server)
            .await;
    }

    let (storage, _directory) = temp_storage(Some(1));
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink_events = std::sync::Arc::clone(&events);
    let sink: latentmail_lib::sync::EventSink = std::sync::Arc::new(move |name, payload| {
        if name == "sync://traversal" {
            sink_events.lock().unwrap().push(payload);
        }
    });
    let registry = WorkRegistry::new();
    let engine = SyncEngine::new(
        storage.clone(),
        create_queue_engine(250, 250, registry.clone()),
        registry,
        sink,
    );
    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    let events = events.lock().unwrap();
    let completed = events
        .iter()
        .rev()
        .find(|event| event["completed"] == true)
        .expect("reconciliation must emit a completed progress event");
    assert_eq!(
        completed["discoveredCount"], 1,
        "one distinct message across three labels must report 1, not 3"
    );
    assert_eq!(
        completed["persistedCount"], 1,
        "one distinct message across three labels must report 1, not 3"
    );
}

#[tokio::test]
async fn a_message_whose_label_set_is_unchanged_is_not_touched_despite_differing_listing_order() {
    let server = MockServer::start().await;
    mount_reconciliation_scaffold(&server).await;

    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("labelIds"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "multi-label", "threadId": "multi-thread"}]
        })))
        .mount(&server)
        .await;
    for label in ["TRASH", "STARRED", "UNREAD"] {
        Mock::given(method("GET"))
            .and(path("/users/me/messages"))
            .and(query_param("labelIds", label))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "messages": [{"id": "multi-label", "threadId": "multi-thread"}]
            })))
            .mount(&server)
            .await;
    }

    let (storage, _directory) = temp_storage(Some(1));
    let connection = storage.connection().unwrap();
    MessageRepository::write_full_state(
        &connection,
        &row("multi-label", "multi-thread", "Real Subject"),
    )
    .unwrap();
    for label in ["TRASH", "STARRED", "UNREAD"] {
        LabelRepository::ensure_placeholder(&connection, "account", label).unwrap();
        MessageRepository::set_label_membership(&connection, "account", "multi-label", label, true)
            .unwrap();
    }
    ThreadRepository::upsert(
        &connection,
        &Thread {
            account_id: "account".into(),
            id: "multi-thread".into(),
            subject: "STALE — must not be recomputed".into(),
            participants: "sender@example.com".into(),
            latest_at: 1,
            message_count: 1,
            is_unread: false,
            is_starred: false,
            has_attachments: false,
            has_draft: false,
            sender_identity: ThreadIdentity {
                display: "sender@example.com".into(),
                address: Some("sender@example.com".into()),
            },
            recipient_identity: None,
        },
    )
    .unwrap();
    drop(connection);

    let registry = WorkRegistry::new();
    let engine = SyncEngine::new(
        storage.clone(),
        create_queue_engine(250, 250, registry.clone()),
        registry,
        noop_event_sink(),
    );
    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    server.verify().await;

    let connection = storage.connection().unwrap();
    let mut labels = MessageRepository::label_ids(&connection, "account", "multi-label").unwrap();
    labels.sort();
    assert_eq!(
        labels,
        vec![
            "STARRED".to_owned(),
            "TRASH".to_owned(),
            "UNREAD".to_owned()
        ],
        "membership must be left exactly as it was"
    );
    let thread = ThreadRepository::get(&connection, "account", "multi-thread")
        .unwrap()
        .unwrap();
    assert_eq!(
        thread.subject, "STALE — must not be recomputed",
        "a message whose label *set* is unchanged must never be marked touched, \
         regardless of listing order"
    );
}

#[tokio::test]
async fn a_reconciled_sent_message_observes_its_recipients_as_contacts() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 1, "threadsTotal": 1, "historyId": "50"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "labels": [{"id": "SENT", "name": "Sent", "type": "system"}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("labelIds"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "sent-1", "threadId": "sent-thread"}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("labelIds", "SENT"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "sent-1", "threadId": "sent-thread"}]
        })))
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage(Some(1));
    let connection = storage.connection().unwrap();
    MessageRepository::write_full_state(
        &connection,
        &row("sent-1", "sent-thread", "Reply to team"),
    )
    .unwrap();
    MessageRepository::set_recipient_roles(
        &connection,
        "account",
        "sent-1",
        "First Recipient <first@example.com>",
        "second@example.com",
        "",
        None,
    )
    .unwrap();
    ThreadRepository::upsert(
        &connection,
        &Thread {
            account_id: "account".into(),
            id: "sent-thread".into(),
            subject: "Reply to team".into(),
            participants: "sender@example.com".into(),
            latest_at: 1,
            message_count: 1,
            is_unread: false,
            is_starred: false,
            has_attachments: false,
            has_draft: false,
            sender_identity: ThreadIdentity {
                display: "sender@example.com".into(),
                address: Some("sender@example.com".into()),
            },
            recipient_identity: None,
        },
    )
    .unwrap();
    drop(connection);

    let registry = WorkRegistry::new();
    let engine = SyncEngine::new(
        storage.clone(),
        create_queue_engine(250, 250, registry.clone()),
        registry,
        noop_event_sink(),
    );
    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    server.verify().await;

    let connection = storage.connection().unwrap();
    let contacts = latentmail_lib::contacts::lookup(&connection, "account", "first").unwrap();
    assert_eq!(contacts.len(), 1, "the `to` recipient must be observed");
    assert_eq!(contacts[0].address, "first@example.com");
    assert_eq!(contacts[0].display_name.as_deref(), Some("First Recipient"));

    let cc_contacts = latentmail_lib::contacts::lookup(&connection, "account", "second").unwrap();
    assert_eq!(cc_contacts.len(), 1, "the `cc` recipient must be observed too");
    assert_eq!(cc_contacts[0].address, "second@example.com");
}
