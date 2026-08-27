use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use latentmail_lib::gmail::GmailClient;
use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, Label, LabelRepository, Message, MessageRepository,
    Storage, ThreadRepository,
};
use latentmail_lib::sync::{EventSink, SyncEngine, WorkRegistry};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, Request, Respond, ResponseTemplate,
};

struct LabelSequence(Mutex<VecDeque<serde_json::Value>>);

impl Respond for LabelSequence {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        let mut pending = self.0.lock().unwrap();
        let labels = if pending.len() > 1 {
            pending.pop_front().unwrap()
        } else {
            pending.front().unwrap().clone()
        };
        ResponseTemplate::new(200).set_body_json(serde_json::json!({ "labels": labels }))
    }
}

type FiredEvents = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

fn fixture_now() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::from_timestamp(3, 0).unwrap()
}

fn seed_label(kind: &str, id: &str, name: &str) -> Label {
    Label {
        account_id: "account".into(),
        id: id.into(),
        name: name.into(),
        kind: kind.into(),
        color: None,
        message_count: 0,
    }
}

fn seed_message(id: &str, thread_id: &str) -> Message {
    Message {
        account_id: "account".into(),
        id: id.into(),
        thread_id: thread_id.into(),
        rfc_message_id: None,
        sender: "alice@example.com".into(),
        recipients: "me@example.com".into(),
        subject: "Invoice".into(),
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

fn engine_with_labels(
    seeded: &[Label],
) -> (Arc<SyncEngine>, Storage, tempfile::TempDir, FiredEvents) {
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
            history_id: Some(40),
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    for label in seeded {
        LabelRepository::upsert(&connection, label).unwrap();
    }
    drop(connection);

    let events = Arc::new(Mutex::new(Vec::new()));
    let events_for_sink = Arc::clone(&events);
    let sink: EventSink = Arc::new(move |name, payload| {
        events_for_sink
            .lock()
            .unwrap()
            .push((name.to_owned(), payload));
    });
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new_with_clock(storage.clone(), queue, registry, sink, fixture_now);
    (engine, storage, directory, events)
}

async fn mount_quiet_history(server: &MockServer, labels: serde_json::Value) {
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "labels": labels
        })))
        .mount(server)
        .await;
    mount_quiet_endpoints(server).await;
}

async fn mount_quiet_endpoints(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"historyId": "40", "history": []})),
        )
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})))
        .mount(server)
        .await;
}

fn changed_flag(events: &FiredEvents) -> Option<serde_json::Value> {
    events
        .lock()
        .unwrap()
        .iter()
        .find(|(name, _)| name == "sync://complete")
        .and_then(|(_, payload)| payload.get("changed").cloned())
}

#[tokio::test]
async fn a_label_added_remotely_is_stored_and_reported_as_a_change_without_message_history() {
    let server = MockServer::start().await;
    mount_quiet_history(
        &server,
        serde_json::json!([{"id": "Label_9", "name": "Invoices", "type": "user"}]),
    )
    .await;
    let (engine, storage, _directory, events) = engine_with_labels(&[]);

    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    let connection = storage.connection().unwrap();
    let stored = LabelRepository::get(&connection, "account", "Label_9")
        .unwrap()
        .expect("the new remote label is persisted");
    assert_eq!(stored.name, "Invoices");
    assert_eq!(changed_flag(&events), Some(serde_json::json!(true)));
}

#[tokio::test]
async fn a_label_deleted_remotely_is_removed_locally_and_reported_as_a_change() {
    let server = MockServer::start().await;
    mount_quiet_history(&server, serde_json::json!([])).await;
    let (engine, storage, _directory, events) =
        engine_with_labels(&[seed_label("user", "Label_9", "Invoices")]);

    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    let connection = storage.connection().unwrap();
    assert!(LabelRepository::get(&connection, "account", "Label_9")
        .unwrap()
        .is_none());
    assert_eq!(changed_flag(&events), Some(serde_json::json!(true)));
}

#[tokio::test]
async fn deleting_a_remote_label_drops_its_thread_label_rows() {
    let server = MockServer::start().await;
    mount_quiet_history(
        &server,
        serde_json::json!([{"id": "INBOX", "name": "INBOX", "type": "system"}]),
    )
    .await;
    let (engine, storage, _directory, _events) = engine_with_labels(&[
        seed_label("system", "INBOX", "INBOX"),
        seed_label("user", "Label_9", "Invoices"),
    ]);
    let connection = storage.connection().unwrap();
    MessageRepository::write_full_state(&connection, &seed_message("m1", "t1")).unwrap();
    MessageRepository::set_label_membership(&connection, "account", "m1", "INBOX", true).unwrap();
    MessageRepository::set_label_membership(&connection, "account", "m1", "Label_9", true).unwrap();
    ThreadRepository::recompute(&connection, "account", "t1").unwrap();
    assert_eq!(
        ThreadRepository::list_paginated(&connection, "account", Some("Label_9"), None, 10)
            .unwrap()
            .len(),
        1
    );
    drop(connection);

    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    let connection = storage.connection().unwrap();
    assert!(
        ThreadRepository::list_paginated(&connection, "account", Some("Label_9"), None, 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        ThreadRepository::list_paginated(&connection, "account", Some("INBOX"), None, 10)
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn a_placeholder_label_the_remote_list_never_returns_survives_the_prune() {
    let server = MockServer::start().await;
    mount_quiet_history(&server, serde_json::json!([])).await;
    let (engine, storage, _directory, events) =
        engine_with_labels(&[seed_label("system", "YELLOW_STAR", "YELLOW_STAR")]);

    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    let connection = storage.connection().unwrap();
    assert!(LabelRepository::get(&connection, "account", "YELLOW_STAR")
        .unwrap()
        .is_some());
    assert_eq!(changed_flag(&events), Some(serde_json::json!(false)));
}

#[tokio::test]
async fn an_unchanged_label_set_leaves_the_sync_reported_as_unchanged() {
    let server = MockServer::start().await;
    mount_quiet_history(
        &server,
        serde_json::json!([{"id": "Label_9", "name": "Invoices", "type": "user"}]),
    )
    .await;
    let (engine, _storage, _directory, events) =
        engine_with_labels(&[seed_label("user", "Label_9", "Invoices")]);

    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    assert_eq!(changed_flag(&events), Some(serde_json::json!(false)));
}

#[tokio::test]
async fn a_label_renamed_remotely_is_reported_as_a_change() {
    let server = MockServer::start().await;
    mount_quiet_history(
        &server,
        serde_json::json!([{"id": "Label_9", "name": "Receipts", "type": "user"}]),
    )
    .await;
    let (engine, storage, _directory, events) =
        engine_with_labels(&[seed_label("user", "Label_9", "Invoices")]);

    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    let connection = storage.connection().unwrap();
    assert_eq!(
        LabelRepository::get(&connection, "account", "Label_9")
            .unwrap()
            .unwrap()
            .name,
        "Receipts"
    );
    assert_eq!(changed_flag(&events), Some(serde_json::json!(true)));
}

fn remote_label(id: &str, name: &str) -> serde_json::Value {
    serde_json::json!({"id": id, "name": name, "type": "user"})
}

fn labelled_thread_count(storage: &Storage, label_id: &str) -> usize {
    let connection = storage.connection().unwrap();
    ThreadRepository::list_paginated(&connection, "account", Some(label_id), None, 10)
        .unwrap()
        .len()
}

#[tokio::test]
async fn a_remote_delete_after_a_local_delete_still_prunes_the_last_label() {
    let inbox = serde_json::json!({"id": "INBOX", "name": "INBOX", "type": "system"});
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(LabelSequence(Mutex::new(VecDeque::from(vec![
            serde_json::json!([
                inbox,
                remote_label("Label_1", "one"),
                remote_label("Label_2", "two"),
                remote_label("Label_3", "three")
            ]),
            serde_json::json!([
                inbox,
                remote_label("Label_2", "two"),
                remote_label("Label_3", "three")
            ]),
            serde_json::json!([inbox, remote_label("Label_3", "three")]),
            serde_json::json!([inbox]),
        ]))))
        .mount(&server)
        .await;
    mount_quiet_endpoints(&server).await;

    let (engine, storage, _directory, _events) = engine_with_labels(&[
        seed_label("system", "INBOX", "INBOX"),
        seed_label("user", "Label_1", "one"),
        seed_label("user", "Label_2", "two"),
        seed_label("user", "Label_3", "three"),
    ]);
    let connection = storage.connection().unwrap();
    for (index, label) in ["Label_1", "Label_2", "Label_3"].iter().enumerate() {
        let message = format!("m{index}");
        let thread = format!("t{index}");
        MessageRepository::write_full_state(&connection, &seed_message(&message, &thread)).unwrap();
        MessageRepository::set_label_membership(&connection, "account", &message, "INBOX", true)
            .unwrap();
        MessageRepository::set_label_membership(&connection, "account", &message, label, true)
            .unwrap();
        ThreadRepository::recompute(&connection, "account", &thread).unwrap();
    }
    drop(connection);
    let client = || GmailClient::with_base_url("token", server.uri());

    engine.run_sync("account", client()).await.unwrap();
    assert_eq!(labelled_thread_count(&storage, "Label_1"), 1);

    engine.run_sync("account", client()).await.unwrap();
    let connection = storage.connection().unwrap();
    assert!(LabelRepository::get(&connection, "account", "Label_1")
        .unwrap()
        .is_none());
    drop(connection);
    assert_eq!(labelled_thread_count(&storage, "Label_1"), 0);

    let connection = storage.connection().unwrap();
    let transaction = connection.unchecked_transaction().unwrap();
    let touched: std::collections::HashSet<String> =
        LabelRepository::threads_with_label(&transaction, "account", "Label_2")
            .unwrap()
            .into_iter()
            .collect();
    LabelRepository::delete(&transaction, "account", "Label_2").unwrap();
    ThreadRepository::recompute_many(&transaction, "account", &touched).unwrap();
    transaction.commit().unwrap();
    drop(connection);

    engine.run_sync("account", client()).await.unwrap();
    engine.run_sync("account", client()).await.unwrap();

    let connection = storage.connection().unwrap();
    assert!(LabelRepository::get(&connection, "account", "Label_3")
        .unwrap()
        .is_none());
    assert!(LabelRepository::get(&connection, "account", "INBOX")
        .unwrap()
        .is_some());
    drop(connection);
    assert_eq!(labelled_thread_count(&storage, "Label_3"), 0);
    assert_eq!(labelled_thread_count(&storage, "INBOX"), 3);
}

#[tokio::test]
async fn a_history_record_cannot_resurrect_a_label_the_remote_list_dropped() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "historyId": "50",
            "history": [{
                "id": "50",
                "labelsAdded": [
                    {"message": {"id": "m1", "threadId": "t1"}, "labelIds": ["Label_9"]}
                ]
            }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})))
        .mount(&server)
        .await;
    let (engine, storage, _directory, _events) =
        engine_with_labels(&[seed_label("user", "Label_9", "Invoices")]);
    let connection = storage.connection().unwrap();
    MessageRepository::write_full_state(&connection, &seed_message("m1", "t1")).unwrap();
    drop(connection);

    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    let connection = storage.connection().unwrap();
    assert!(LabelRepository::get(&connection, "account", "Label_9")
        .unwrap()
        .is_none());
}
