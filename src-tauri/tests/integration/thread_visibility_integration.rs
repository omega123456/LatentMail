use latentmail_lib::ipc::{AppServices, CommandPayload};
use latentmail_lib::storage::{LabelMembershipChange, MessageKey, ThreadPageQuery};
use latentmail_lib::sync::triage::{
    DeleteMessagesRequest, DeleteThreadsRequest, MoveMessagesRequest, MoveThreadsRequest,
};
use latentmail_lib::sync::{LabelDelta, SyncEngineDeps, ThreadPageDirection};
use std::{collections::HashSet, sync::Arc};

use latentmail_lib::{
    auth::{save_refresh_token, AuthService},
    storage::{
        Account, AccountRepository, HtmlPresence, LabelRepository, Message, MessageRepository,
        Storage, ThreadRepository,
    },
    sync::{
        create_queue_engine, noop_event_sink,
        triage::{
            delete_labels, delete_messages, delete_threads, message_raw_membership, move_labels,
            move_messages, move_threads, thread_raw_membership,
        },
        SyncEngine, WorkRegistry,
    },
};
use tauri::Manager;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn account() -> Account {
    Account {
        id: "account".into(),
        email: "mail@example.com".into(),
        display_name: "Mail".into(),
        avatar_url: None,
        history_id: Some(4),
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}

fn message(id: &str, thread_id: &str, sent_at: i64) -> Message {
    Message {
        account_id: "account".into(),
        id: id.into(),
        thread_id: thread_id.into(),
        rfc_message_id: None,
        sender: "sender@example.com".into(),
        recipients: "recipient@example.com".into(),
        subject: "Subject".into(),
        sent_at: sent_at,
        snippet: "Snippet".into(),
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

fn seed_labels(connection: &rusqlite::Connection) {
    for label_id in [
        "INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "UNREAD", "STARRED", "Label_1",
    ] {
        LabelRepository::ensure_placeholder(connection, "account", label_id).unwrap();
    }
}

fn indexed_labels(connection: &rusqlite::Connection, thread_id: &str) -> Vec<String> {
    let mut statement = connection
        .prepare("SELECT label_id FROM thread_labels WHERE account_id='account' AND thread_id=?1 ORDER BY label_id")
        .unwrap();
    let mut labels: Vec<String> = statement
        .query_map([thread_id], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    labels.sort();
    labels
}

fn thread_exists_under_label(
    connection: &rusqlite::Connection,
    label_id: &str,
    thread_id: &str,
) -> bool {
    let rows = ThreadRepository::list_paginated(
        connection,
        ThreadPageQuery {
            account_id: "account",
            label_id: Some(label_id),
            cursor: None,
            limit: 100,
            direction: ThreadPageDirection::default(),
        },
    )
    .unwrap();
    rows.iter().any(|row| row.thread.id == thread_id)
}

fn memory_connection() -> rusqlite::Connection {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    seed_labels(&connection);
    connection
}

fn add_label(connection: &rusqlite::Connection, message_id: &str, label_id: &str) {
    MessageRepository::set_label_membership(
        connection,
        MessageKey {
            account_id: "account",
            message_id: message_id,
        },
        LabelMembershipChange {
            label_id: label_id,
            present: true,
        },
    )
    .unwrap();
}

fn remove_label(connection: &rusqlite::Connection, message_id: &str, label_id: &str) {
    MessageRepository::set_label_membership(
        connection,
        MessageKey {
            account_id: "account",
            message_id: message_id,
        },
        LabelMembershipChange {
            label_id: label_id,
            present: false,
        },
    )
    .unwrap();
}

fn apply_delta(connection: &rusqlite::Connection, message_id: &str, delta: &LabelDelta) {
    for label in &delta.additions {
        add_label(connection, message_id, label);
    }
    for label in &delta.removals {
        remove_label(connection, message_id, label);
    }
}

#[test]
fn deleting_a_thread_found_in_sent_removes_it_from_sent_and_shows_it_in_trash() {
    let connection = memory_connection();
    MessageRepository::write_full_state(&connection, &message("m1", "thread-1", 10)).unwrap();
    add_label(&connection, "m1", "SENT");
    add_label(&connection, "m1", "Label_1");
    ThreadRepository::recompute(&connection, "account", "thread-1").unwrap();

    assert!(thread_exists_under_label(&connection, "SENT", "thread-1"));
    assert!(!thread_exists_under_label(&connection, "TRASH", "thread-1"));

    let membership = thread_raw_membership(&connection, "account", "thread-1").unwrap();
    let delta = delete_labels(&membership);
    assert_eq!(delta.additions, HashSet::from(["TRASH".to_owned()]));
    assert!(
        delta.removals.is_empty(),
        "SENT must never be removed by delete"
    );
    apply_delta(&connection, "m1", &delta);
    ThreadRepository::recompute(&connection, "account", "thread-1").unwrap();

    assert!(
        !thread_exists_under_label(&connection, "SENT", "thread-1"),
        "a trashed message carves out to TRASH only, so it leaves the Sent listing"
    );
    assert!(thread_exists_under_label(&connection, "TRASH", "thread-1"));

    let remaining_raw = thread_raw_membership(&connection, "account", "thread-1").unwrap();
    assert!(
        remaining_raw.contains("SENT"),
        "the message still really carries SENT even though it no longer badges as Sent"
    );
    assert!(
        remaining_raw.contains("Label_1"),
        "delete must never remove a user label"
    );

    remove_label(&connection, "m1", "TRASH");
    ThreadRepository::recompute(&connection, "account", "thread-1").unwrap();
    assert!(
        thread_exists_under_label(&connection, "SENT", "thread-1"),
        "restoring removes TRASH and the thread returns to Sent with its labels intact"
    );
    assert!(indexed_labels(&connection, "thread-1").contains(&"Label_1".to_owned()));
}

#[test]
fn trash_and_spam_list_exactly_what_they_contain() {
    let connection = memory_connection();
    MessageRepository::write_full_state(&connection, &message("m1", "thread-1", 10)).unwrap();
    add_label(&connection, "m1", "INBOX");
    add_label(&connection, "m1", "TRASH");
    ThreadRepository::recompute(&connection, "account", "thread-1").unwrap();

    assert_eq!(
        indexed_labels(&connection, "thread-1"),
        vec!["TRASH".to_owned()]
    );
    assert!(thread_exists_under_label(&connection, "TRASH", "thread-1"));
    assert!(
        !thread_exists_under_label(&connection, "INBOX", "thread-1"),
        "a trashed message carves out of every other folder"
    );

    MessageRepository::write_full_state(&connection, &message("m2", "thread-2", 20)).unwrap();
    add_label(&connection, "m2", "INBOX");
    add_label(&connection, "m2", "SPAM");
    ThreadRepository::recompute(&connection, "account", "thread-2").unwrap();

    assert_eq!(
        indexed_labels(&connection, "thread-2"),
        vec!["SPAM".to_owned()]
    );
    assert!(thread_exists_under_label(&connection, "SPAM", "thread-2"));
    assert!(!thread_exists_under_label(&connection, "INBOX", "thread-2"));
}

#[test]
fn a_thread_with_one_trashed_and_one_live_message_still_appears_in_the_live_folder() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    seed_labels(&connection);
    MessageRepository::write_full_state(&connection, &message("m1", "thread-1", 10)).unwrap();
    MessageRepository::set_label_membership(
        &connection,
        MessageKey {
            account_id: "account",
            message_id: "m1",
        },
        LabelMembershipChange {
            label_id: "INBOX",
            present: true,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(&connection, &message("m2", "thread-1", 20)).unwrap();
    MessageRepository::set_label_membership(
        &connection,
        MessageKey {
            account_id: "account",
            message_id: "m2",
        },
        LabelMembershipChange {
            label_id: "TRASH",
            present: true,
        },
    )
    .unwrap();
    ThreadRepository::recompute(&connection, "account", "thread-1").unwrap();

    let labels = indexed_labels(&connection, "thread-1");
    assert!(labels.contains(&"INBOX".to_owned()));
    assert!(labels.contains(&"TRASH".to_owned()));
    assert!(thread_exists_under_label(&connection, "INBOX", "thread-1"));
    assert!(thread_exists_under_label(&connection, "TRASH", "thread-1"));
}

fn listed_message_count(connection: &rusqlite::Connection, label_id: &str, thread_id: &str) -> i64 {
    ThreadRepository::list_paginated(
        connection,
        ThreadPageQuery {
            account_id: "account",
            label_id: Some(label_id),
            cursor: None,
            limit: 100,
            direction: ThreadPageDirection::default(),
        },
    )
    .unwrap()
    .into_iter()
    .find(|row| row.thread.id == thread_id)
    .expect("thread must be listed under the label")
    .thread
    .message_count
}

#[test]
fn the_listed_message_count_leaves_out_trashed_and_spammed_messages_outside_trash_and_spam() {
    let connection = memory_connection();
    for (id, sent_at) in [("m1", 10), ("m2", 20), ("m3", 30)] {
        MessageRepository::write_full_state(&connection, &message(id, "thread-1", sent_at))
            .unwrap();
        add_label(&connection, id, "INBOX");
    }
    MessageRepository::write_full_state(&connection, &message("m4", "thread-1", 40)).unwrap();
    add_label(&connection, "m4", "INBOX");
    add_label(&connection, "m4", "TRASH");
    ThreadRepository::recompute(&connection, "account", "thread-1").unwrap();

    assert_eq!(listed_message_count(&connection, "INBOX", "thread-1"), 3);
    assert_eq!(listed_message_count(&connection, "TRASH", "thread-1"), 4);

    remove_label(&connection, "m4", "TRASH");
    add_label(&connection, "m4", "SPAM");
    ThreadRepository::recompute(&connection, "account", "thread-1").unwrap();

    assert_eq!(listed_message_count(&connection, "INBOX", "thread-1"), 3);
    assert_eq!(listed_message_count(&connection, "SPAM", "thread-1"), 4);
}

#[test]
fn trashing_every_message_removes_the_thread_from_every_listing_but_trash() {
    let connection = memory_connection();
    MessageRepository::write_full_state(&connection, &message("m1", "thread-1", 10)).unwrap();
    add_label(&connection, "m1", "INBOX");
    MessageRepository::write_full_state(&connection, &message("m2", "thread-1", 20)).unwrap();
    add_label(&connection, "m2", "INBOX");
    ThreadRepository::recompute(&connection, "account", "thread-1").unwrap();
    assert!(thread_exists_under_label(&connection, "INBOX", "thread-1"));

    add_label(&connection, "m1", "TRASH");
    add_label(&connection, "m2", "TRASH");
    ThreadRepository::recompute(&connection, "account", "thread-1").unwrap();

    assert_eq!(
        indexed_labels(&connection, "thread-1"),
        vec!["TRASH".to_owned()]
    );
    assert!(!thread_exists_under_label(&connection, "INBOX", "thread-1"));
    assert!(thread_exists_under_label(&connection, "TRASH", "thread-1"));
}

#[test]
fn delete_and_move_never_emit_sent_or_draft_and_never_remove_a_user_label() {
    let membership: HashSet<String> = ["SENT", "DRAFT", "INBOX", "Label_1"]
        .into_iter()
        .map(str::to_owned)
        .collect();

    let LabelDelta {
        additions: add,
        removals: remove,
    } = delete_labels(&membership);
    assert_eq!(add, HashSet::from(["TRASH".to_owned()]));
    assert_eq!(remove, HashSet::from(["INBOX".to_owned()]));
    assert!(!add.contains("SENT") && !remove.contains("SENT"));
    assert!(!add.contains("DRAFT") && !remove.contains("DRAFT"));
    assert!(!remove.contains("Label_1"));

    let LabelDelta {
        additions: add,
        removals: remove,
    } = move_labels(&membership, "SPAM");
    assert_eq!(add, HashSet::from(["SPAM".to_owned()]));
    assert_eq!(remove, HashSet::from(["INBOX".to_owned()]));
    assert!(!add.contains("SENT") && !remove.contains("SENT"));
    assert!(!add.contains("DRAFT") && !remove.contains("DRAFT"));
    assert!(!remove.contains("Label_1"));
}

#[test]
fn delete_and_move_produce_identical_label_changes_regardless_of_which_mailbox_is_selected() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    seed_labels(&connection);
    MessageRepository::write_full_state(&connection, &message("m1", "thread-1", 10)).unwrap();
    MessageRepository::set_label_membership(
        &connection,
        MessageKey {
            account_id: "account",
            message_id: "m1",
        },
        LabelMembershipChange {
            label_id: "INBOX",
            present: true,
        },
    )
    .unwrap();
    MessageRepository::set_label_membership(
        &connection,
        MessageKey {
            account_id: "account",
            message_id: "m1",
        },
        LabelMembershipChange {
            label_id: "Label_1",
            present: true,
        },
    )
    .unwrap();
    ThreadRepository::recompute(&connection, "account", "thread-1").unwrap();

    let membership = thread_raw_membership(&connection, "account", "thread-1").unwrap();

    let from_inbox = delete_labels(&membership);
    let from_label = delete_labels(&membership);
    let from_no_selection = delete_labels(&membership);
    assert_eq!(from_inbox, from_label);
    assert_eq!(from_inbox, from_no_selection);

    let move_from_inbox = move_labels(&membership, "SPAM");
    let move_from_label = move_labels(&membership, "SPAM");
    assert_eq!(move_from_inbox, move_from_label);
}

#[test]
fn moving_a_thread_out_of_a_user_label_view_leaves_it_in_that_label() {
    let connection = memory_connection();
    MessageRepository::write_full_state(&connection, &message("m1", "thread-1", 10)).unwrap();
    add_label(&connection, "m1", "INBOX");
    add_label(&connection, "m1", "Label_1");
    ThreadRepository::recompute(&connection, "account", "thread-1").unwrap();

    let membership = thread_raw_membership(&connection, "account", "thread-1").unwrap();
    let delta = move_labels(&membership, "SPAM");
    assert!(!delta.removals.contains("Label_1"));

    apply_delta(&connection, "m1", &delta);
    ThreadRepository::recompute(&connection, "account", "thread-1").unwrap();

    assert!(thread_exists_under_label(&connection, "SPAM", "thread-1"));
    let labels = indexed_labels(&connection, "thread-1");
    assert!(
        !labels.contains(&"Label_1".to_owned()),
        "SPAM's carve-out means a spammed message's label index only shows SPAM"
    );
    let raw = thread_raw_membership(&connection, "account", "thread-1").unwrap();
    assert!(
        raw.contains("Label_1"),
        "the thread still really carries the user label even though a spammed message hides it from the badge index"
    );
}

#[test]
fn message_level_delete_and_move_follow_the_messages_own_membership() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    seed_labels(&connection);
    MessageRepository::write_full_state(&connection, &message("m1", "thread-1", 10)).unwrap();
    MessageRepository::set_label_membership(
        &connection,
        MessageKey {
            account_id: "account",
            message_id: "m1",
        },
        LabelMembershipChange {
            label_id: "INBOX",
            present: true,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(&connection, &message("m2", "thread-1", 20)).unwrap();
    MessageRepository::set_label_membership(
        &connection,
        MessageKey {
            account_id: "account",
            message_id: "m2",
        },
        LabelMembershipChange {
            label_id: "SPAM",
            present: true,
        },
    )
    .unwrap();

    let m1_membership = message_raw_membership(&connection, "account", "m1").unwrap();
    let LabelDelta {
        additions: m1_add,
        removals: m1_remove,
    } = delete_labels(&m1_membership);
    assert_eq!(m1_add, HashSet::from(["TRASH".to_owned()]));
    assert_eq!(m1_remove, HashSet::from(["INBOX".to_owned()]));

    let m2_membership = message_raw_membership(&connection, "account", "m2").unwrap();
    let LabelDelta {
        additions: m2_add,
        removals: m2_remove,
    } = move_labels(&m2_membership, "INBOX");
    assert_eq!(m2_add, HashSet::from(["INBOX".to_owned()]));
    assert_eq!(m2_remove, HashSet::from(["SPAM".to_owned()]));
}

use crate::support::app;

fn account_with_id(account_id: &str, email: &str) -> Account {
    Account {
        id: account_id.into(),
        email: email.into(),
        display_name: "A".into(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: false,
        created_at: 0,
        updated_at: 0,
    }
}

fn build_engine(storage: Storage) -> Arc<SyncEngine> {
    let registry = WorkRegistry::new();
    let queue = create_queue_engine(1_000, 1_000, Arc::clone(&registry));
    SyncEngine::new(SyncEngineDeps {
        storage: storage,
        queue: queue,
        registry: registry,
        events: noop_event_sink(),
    })
}

fn seeded_intent_engine(account_id: &str) -> (Arc<SyncEngine>, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account_with_id(account_id, "a@example.com")).unwrap();
    for label in ["INBOX", "SENT", "TRASH", "SPAM", "UNREAD"] {
        LabelRepository::ensure_placeholder(&connection, account_id, label).unwrap();
    }
    let stored = Message {
        account_id: account_id.into(),
        sender: "A".into(),
        recipients: "B".into(),
        snippet: String::new(),
        is_unread: true,
        ..message("message-1", "thread-1", 0)
    };
    MessageRepository::write_full_state(&connection, &stored).unwrap();
    MessageRepository::set_label_membership(
        &connection,
        MessageKey {
            account_id: account_id,
            message_id: "message-1",
        },
        LabelMembershipChange {
            label_id: "INBOX",
            present: true,
        },
    )
    .unwrap();
    drop(connection);
    (build_engine(storage), directory)
}

async fn mount_token_and_message_mocks(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "access_token": "fresh", "token_type": "Bearer" }),
            ),
        )
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .respond_with(|request: &wiremock::Request| {
            let id = request.url.path().rsplit('/').next().unwrap_or_default();
            ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": id, "threadId": "thread-1", "historyId": "2",
                "labelIds": ["INBOX"], "snippet": "", "internalDate": "0",
                "payload": { "headers": [] }
            }))
        })
        .mount(server)
        .await;
}

#[tokio::test]
async fn delete_threads_intent_computes_labels_from_real_membership_and_batch_modifies() {
    let server = MockServer::start().await;
    mount_token_and_message_mocks(&server).await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    save_refresh_token("account-delete-threads", "refresh").unwrap();
    let (engine, _directory) = seeded_intent_engine("account-delete-threads");
    let app = app();
    app.manage(engine.storage().clone());
    app.manage(AuthService::new(engine.storage().clone()));
    app.manage(engine);

    let results = delete_threads(
        AppServices::new(app.handle()),
        CommandPayload(DeleteThreadsRequest {
            account_id: "account-delete-threads".into(),
            thread_ids: vec!["thread-1".into()],
        }),
    )
    .await
    .unwrap();
    assert_eq!(results.len(), 1);

    let requests = server.received_requests().await.unwrap();
    let body = requests
        .iter()
        .find(|request| request.url.path() == "/users/me/messages/batchModify")
        .unwrap()
        .body_json::<serde_json::Value>()
        .unwrap();
    assert_eq!(body["addLabelIds"], serde_json::json!(["TRASH"]));
    assert_eq!(body["removeLabelIds"], serde_json::json!(["INBOX"]));
}

#[tokio::test]
async fn move_threads_intent_computes_labels_from_real_membership_and_batch_modifies() {
    let server = MockServer::start().await;
    mount_token_and_message_mocks(&server).await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    save_refresh_token("account-move-threads", "refresh").unwrap();
    let (engine, _directory) = seeded_intent_engine("account-move-threads");
    let app = app();
    app.manage(engine.storage().clone());
    app.manage(AuthService::new(engine.storage().clone()));
    app.manage(engine);

    let results = move_threads(
        AppServices::new(app.handle()),
        CommandPayload(MoveThreadsRequest {
            account_id: "account-move-threads".into(),
            thread_ids: vec!["thread-1".into()],
            destination: "SPAM".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(results.len(), 1);

    let requests = server.received_requests().await.unwrap();
    let body = requests
        .iter()
        .find(|request| request.url.path() == "/users/me/messages/batchModify")
        .unwrap()
        .body_json::<serde_json::Value>()
        .unwrap();
    assert_eq!(body["addLabelIds"], serde_json::json!(["SPAM"]));
    assert_eq!(body["removeLabelIds"], serde_json::json!(["INBOX"]));
}

#[tokio::test]
async fn move_threads_rejects_an_unrecognised_destination_before_touching_gmail() {
    let server = MockServer::start().await;
    mount_token_and_message_mocks(&server).await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    save_refresh_token("account-move-invalid", "refresh").unwrap();
    let (engine, _directory) = seeded_intent_engine("account-move-invalid");
    let app = app();
    app.manage(engine.storage().clone());
    app.manage(AuthService::new(engine.storage().clone()));
    app.manage(engine);

    let error = move_threads(
        AppServices::new(app.handle()),
        CommandPayload(MoveThreadsRequest {
            account_id: "account-move-invalid".into(),
            thread_ids: vec!["thread-1".into()],
            destination: "SENT".into(),
        }),
    )
    .await
    .unwrap_err();
    assert!(error.contains("not a valid move destination"));
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn delete_messages_intent_computes_labels_from_the_messages_own_membership() {
    let server = MockServer::start().await;
    mount_token_and_message_mocks(&server).await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    save_refresh_token("account-delete-messages", "refresh").unwrap();
    let (engine, _directory) = seeded_intent_engine("account-delete-messages");
    let app = app();
    app.manage(engine.storage().clone());
    app.manage(AuthService::new(engine.storage().clone()));
    app.manage(engine);

    delete_messages(
        AppServices::new(app.handle()),
        CommandPayload(DeleteMessagesRequest {
            account_id: "account-delete-messages".into(),
            message_ids: vec!["message-1".into()],
        }),
    )
    .await
    .unwrap();

    let requests = server.received_requests().await.unwrap();
    let body = requests
        .iter()
        .find(|request| request.url.path() == "/users/me/messages/batchModify")
        .unwrap()
        .body_json::<serde_json::Value>()
        .unwrap();
    assert_eq!(body["addLabelIds"], serde_json::json!(["TRASH"]));
    assert_eq!(body["removeLabelIds"], serde_json::json!(["INBOX"]));
}

#[tokio::test]
async fn move_messages_intent_computes_labels_from_the_messages_own_membership() {
    let server = MockServer::start().await;
    mount_token_and_message_mocks(&server).await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    save_refresh_token("account-move-messages", "refresh").unwrap();
    let (engine, _directory) = seeded_intent_engine("account-move-messages");
    let app = app();
    app.manage(engine.storage().clone());
    app.manage(AuthService::new(engine.storage().clone()));
    app.manage(engine);

    move_messages(
        AppServices::new(app.handle()),
        CommandPayload(MoveMessagesRequest {
            account_id: "account-move-messages".into(),
            message_ids: vec!["message-1".into()],
            destination: "SPAM".into(),
        }),
    )
    .await
    .unwrap();

    let requests = server.received_requests().await.unwrap();
    let body = requests
        .iter()
        .find(|request| request.url.path() == "/users/me/messages/batchModify")
        .unwrap()
        .body_json::<serde_json::Value>()
        .unwrap();
    assert_eq!(body["addLabelIds"], serde_json::json!(["SPAM"]));
    assert_eq!(body["removeLabelIds"], serde_json::json!(["INBOX"]));
}

#[tokio::test]
async fn move_messages_rejects_an_unrecognised_destination_before_touching_gmail() {
    let server = MockServer::start().await;
    mount_token_and_message_mocks(&server).await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    save_refresh_token("account-move-messages-invalid", "refresh").unwrap();
    let (engine, _directory) = seeded_intent_engine("account-move-messages-invalid");
    let app = app();
    app.manage(engine.storage().clone());
    app.manage(AuthService::new(engine.storage().clone()));
    app.manage(engine);

    let error = move_messages(
        AppServices::new(app.handle()),
        CommandPayload(MoveMessagesRequest {
            account_id: "account-move-messages-invalid".into(),
            message_ids: vec!["message-1".into()],
            destination: "DRAFT".into(),
        }),
    )
    .await
    .unwrap_err();
    assert!(error.contains("not a valid move destination"));
    assert!(server.received_requests().await.unwrap().is_empty());
}

async fn mount_draft_delete_server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "access_token": "fresh", "token_type": "Bearer" }),
            ),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "drafts": [{ "id": "draft-1", "message": { "id": "message-draft" } }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/users/me/drafts/draft-1"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    server
}

fn seed_draft_thread_storage(account_id: &str) -> (Storage, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &account_with_id(account_id, "draft@example.com"),
    )
    .unwrap();
    LabelRepository::ensure_placeholder(&connection, account_id, "DRAFT").unwrap();
    let stored = Message {
        account_id: account_id.into(),
        sender: "A".into(),
        recipients: "B".into(),
        subject: "Draft".into(),
        snippet: String::new(),
        ..message("message-draft", "thread-draft", 0)
    };
    MessageRepository::write_full_state(&connection, &stored).unwrap();
    MessageRepository::set_label_membership(
        &connection,
        MessageKey {
            account_id: account_id,
            message_id: "message-draft",
        },
        LabelMembershipChange {
            label_id: "DRAFT",
            present: true,
        },
    )
    .unwrap();
    drop(connection);
    (storage, directory)
}

async fn run_delete_draft_thread_check() {
    let server = mount_draft_delete_server().await;
    let account_id = "account-delete-draft-thread";
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    save_refresh_token(account_id, "refresh").unwrap();

    let (storage, _directory) = seed_draft_thread_storage(account_id);
    let engine = build_engine(storage.clone());
    let app = app();
    app.manage(storage.clone());
    app.manage(AuthService::new(storage));
    app.manage(engine);
    delete_threads(
        AppServices::new(app.handle()),
        CommandPayload(DeleteThreadsRequest {
            account_id: account_id.into(),
            thread_ids: vec!["thread-draft".into()],
        }),
    )
    .await
    .unwrap();
    let requests = server.received_requests().await.unwrap();
    assert!(requests
        .iter()
        .all(|request| request.url.path() != "/users/me/messages/batchModify"));
}

#[test]
fn deleting_a_draft_thread_through_the_delete_intent_never_batch_modifies_it() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(run_delete_draft_thread_check());
}

fn listed_order(connection: &rusqlite::Connection, label_id: &str) -> Vec<(String, i64)> {
    ThreadRepository::list_paginated(
        connection,
        ThreadPageQuery {
            account_id: "account",
            label_id: Some(label_id),
            cursor: None,
            limit: 100,
            direction: ThreadPageDirection::default(),
        },
    )
    .unwrap()
    .into_iter()
    .map(|row| (row.thread.id, row.thread.latest_at))
    .collect()
}

#[test]
fn forwarding_an_old_message_does_not_bump_its_thread_up_the_inbox() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    seed_labels(&connection);
    MessageRepository::write_full_state(&connection, &message("received", "thread-old", 10))
        .unwrap();
    MessageRepository::set_label_membership(
        &connection,
        MessageKey {
            account_id: "account",
            message_id: "received",
        },
        LabelMembershipChange {
            label_id: "INBOX",
            present: true,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(&connection, &message("forward", "thread-old", 100))
        .unwrap();
    MessageRepository::set_label_membership(
        &connection,
        MessageKey {
            account_id: "account",
            message_id: "forward",
        },
        LabelMembershipChange {
            label_id: "SENT",
            present: true,
        },
    )
    .unwrap();
    ThreadRepository::recompute(&connection, "account", "thread-old").unwrap();

    MessageRepository::write_full_state(&connection, &message("newer", "thread-new", 50)).unwrap();
    MessageRepository::set_label_membership(
        &connection,
        MessageKey {
            account_id: "account",
            message_id: "newer",
        },
        LabelMembershipChange {
            label_id: "INBOX",
            present: true,
        },
    )
    .unwrap();
    ThreadRepository::recompute(&connection, "account", "thread-new").unwrap();

    assert_eq!(
        listed_order(&connection, "INBOX"),
        vec![("thread-new".to_owned(), 50), ("thread-old".to_owned(), 10)],
        "the inbox orders a thread by its newest inbox message, not by the forward"
    );
    assert_eq!(
        listed_order(&connection, "SENT"),
        vec![("thread-old".to_owned(), 100)],
        "sent orders the same thread by the forward"
    );
}
