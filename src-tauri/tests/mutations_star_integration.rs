use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use latentmail_lib::{
    gmail::GmailClient,
    queue::{Executor, Lane, OperationKind, QueueEngine, QueueOperation},
    storage::{
        Account, AccountRepository, Label, LabelRepository, Message, MessageRepository, Storage,
    },
    sync::{create_queue_engine_with_events, noop_event_sink, SyncEngine, WorkRegistry},
};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn operation(id: String, lane: Lane, entity_key: String) -> QueueOperation {
    QueueOperation {
        id,
        account_id: "account".into(),
        lane,
        kind: OperationKind::Star,
        entity_key,
        cost: 0,
        attempts: 0,
    }
}

/// Account + INBOX/STARRED labels + one message per thread (`message-a` in
/// `thread-a`, `message-b` in `thread-b`) — the shared fixture for the two
/// engine-level mutation tests.
fn seed_two_threads() -> (Storage, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "a@example.com".into(),
            display_name: "A".into(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 0,
            updated_at: 0,
        },
    )
    .unwrap();
    for (id, name) in [("INBOX", "Inbox"), ("STARRED", "Starred")] {
        LabelRepository::upsert(
            &connection,
            &Label {
                account_id: "account".into(),
                id: id.into(),
                name: name.into(),
                kind: "system".into(),
                color: None,
                message_count: 0,
                unread_count: 0,
            },
        )
        .unwrap();
    }
    for (id, thread_id) in [("message-a", "thread-a"), ("message-b", "thread-b")] {
        MessageRepository::write_full_state(
            &connection,
            &Message {
                account_id: "account".into(),
                id: id.into(),
                thread_id: thread_id.into(),
                rfc_message_id: None,
                sender: "A".into(),
                recipients: "B".into(),
                subject: "Subject".into(),
                sent_at: 1,
                snippet: "before".into(),
                html_body: None,
                plain_body: None,
                has_attachments: false,
                is_unread: true,
                is_starred: false,
                history_id: 1,
            },
        )
        .unwrap();
    }
    drop(connection);
    (storage, directory)
}

#[tokio::test]
async fn interactive_star_dispatches_with_500_background_operations_queued() {
    let star_started = Arc::new(AtomicBool::new(false));
    let executor: Executor = {
        let star_started = Arc::clone(&star_started);
        Arc::new(move |operation| {
            let star_started = Arc::clone(&star_started);
            Box::pin(async move {
                if operation.lane == Lane::Interactive {
                    star_started.store(true, Ordering::Release);
                } else {
                    std::future::pending::<()>().await;
                }
                Ok(())
            })
        })
    };
    let queue = QueueEngine::new(1_000, 1_000, executor);
    for index in 0..500 {
        queue
            .enqueue(operation(
                format!("background-{index}"),
                Lane::Background,
                format!("background-{index}"),
            ))
            .await
            .unwrap();
    }
    queue
        .enqueue(operation(
            "star".into(),
            Lane::Interactive,
            "thread:starred".into(),
        ))
        .await
        .unwrap();
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    assert!(star_started.load(Ordering::Acquire));
}

#[test]
fn mutation_history_write_back_rejects_an_older_full_state() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "a@example.com".into(),
            display_name: "A".into(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 0,
            updated_at: 0,
        },
    )
    .unwrap();
    let message = |history_id| Message {
        account_id: "account".into(),
        id: "message".into(),
        thread_id: "thread".into(),
        rfc_message_id: None,
        sender: "A".into(),
        recipients: "B".into(),
        subject: "Subject".into(),
        sent_at: 0,
        snippet: "".into(),
        html_body: None,
        plain_body: None,
        has_attachments: false,
        is_unread: true,
        is_starred: false,
        history_id,
    };
    assert!(MessageRepository::write_full_state(&connection, &message(10)).unwrap());
    MessageRepository::write_mutation_history(&connection, "account", &["message".into()], 20)
        .unwrap();
    assert!(!MessageRepository::write_full_state(&connection, &message(15)).unwrap());
}

/// Drives two concurrent stars on *different* threads through the engine, so
/// the 1 ms coalescing window is the thing under test — calling
/// `GmailClient::batch_modify` with two ids directly would prove nothing
/// about whether the engine ever groups them.
#[tokio::test(start_paused = true)]
async fn rapid_distinct_thread_stars_coalesce_into_one_batch_modify_request() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .expect(1)
        .mount(&server)
        .await;
    for id in ["message-a", "message-b"] {
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": id, "threadId": if id == "message-a" { "thread-a" } else { "thread-b" },
                "historyId": "20", "labelIds": ["INBOX", "STARRED"], "snippet": "updated",
                "internalDate": "1", "payload": { "headers": [] }
            })))
            .mount(&server)
            .await;
    }
    let (storage, _directory) = seed_two_threads();
    let registry = WorkRegistry::new();
    let queue = create_queue_engine_with_events(1_000, 1_000, Arc::clone(&registry), {
        Arc::new(move |_event, _payload| {})
    });
    let engine = SyncEngine::new(storage, Arc::clone(&queue), registry, noop_event_sink());

    let stars = ["thread-a", "thread-b"].map(|thread_id| {
        let engine = Arc::clone(&engine);
        let base_url = server.uri();
        tokio::spawn(async move {
            engine
                .mutate_thread(
                    "account",
                    GmailClient::with_base_url("token", base_url),
                    thread_id.into(),
                    "STARRED",
                    true,
                )
                .await
        })
    });
    for star in stars {
        star.await.unwrap().unwrap();
    }

    let batches = server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|request| request.url.path() == "/users/me/messages/batchModify")
        .collect::<Vec<_>>();
    assert_eq!(batches.len(), 1, "both stars must share one request");
    let mut ids = batches[0].body_json::<serde_json::Value>().unwrap()["ids"]
        .as_array()
        .unwrap()
        .clone();
    ids.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
    assert_eq!(
        serde_json::Value::Array(ids),
        serde_json::json!(["message-a", "message-b"])
    );
}

#[tokio::test(start_paused = true)]
async fn sync_engine_star_preempts_500_background_operations_and_coalesces_threads() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;
    for id in ["message-a", "message-b"] {
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": id, "threadId": if id == "message-a" { "thread-a" } else { "thread-b" },
                "historyId": "20", "labelIds": ["INBOX", "STARRED"], "snippet": "updated",
                "internalDate": "1", "payload": { "headers": [] }
            })))
            .mount(&server)
            .await;
    }
    let (storage, _directory) = seed_two_threads();
    let registry = WorkRegistry::new();
    let dispatched = Arc::new(std::sync::Mutex::new(Vec::new()));
    let queue = create_queue_engine_with_events(1_000, 1_000, Arc::clone(&registry), {
        let dispatched = Arc::clone(&dispatched);
        Arc::new(move |event, payload| {
            if event == "queue://item" && payload["status"] == "active" {
                dispatched
                    .lock()
                    .unwrap()
                    .push(payload["id"].as_str().unwrap().to_owned());
            }
        })
    });
    let engine = SyncEngine::new(
        storage.clone(),
        Arc::clone(&queue),
        registry,
        noop_event_sink(),
    );
    queue.pause();
    for index in 0..500 {
        queue
            .enqueue(operation(
                format!("background-{index}"),
                Lane::Background,
                format!("background-{index}"),
            ))
            .await
            .unwrap();
    }
    let first_engine = Arc::clone(&engine);
    let first_server = server.uri();
    let first = tokio::spawn(async move {
        first_engine
            .mutate_thread(
                "account",
                GmailClient::with_base_url("token", first_server),
                "thread-a".into(),
                "STARRED",
                true,
            )
            .await
    });
    for _ in 0..100 {
        if queue.summary().pending == 501 {
            break;
        }
        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
    }
    assert_eq!(queue.summary().pending, 501);
    queue.resume();
    first.await.unwrap().unwrap();
    let requests = server.received_requests().await.unwrap();
    let batch = requests
        .iter()
        .filter(|request| request.url.path() == "/users/me/messages/batchModify")
        .collect::<Vec<_>>();
    assert_eq!(batch.len(), 1);
    let mut ids = batch[0].body_json::<serde_json::Value>().unwrap()["ids"]
        .as_array()
        .unwrap()
        .clone();
    ids.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
    assert_eq!(
        serde_json::Value::Array(ids),
        serde_json::json!(["message-a"])
    );
    let dispatched = dispatched.lock().unwrap();
    let star = dispatched
        .iter()
        .position(|id| id.starts_with("mutation:account:"))
        .unwrap();
    assert!(dispatched[..star]
        .iter()
        .all(|id| !id.starts_with("background-")));
    let connection = storage.connection().unwrap();
    assert_eq!(
        MessageRepository::list_by_thread(&connection, "account", "thread-a").unwrap()[0]
            .history_id,
        20
    );
}

/// Real Gmail answers `batchModify` with 204 and an empty body — the mocked
/// `{}` responses above hide that. Anything less than a full round trip here
/// (star, message re-read, persisted history id) would still pass while the
/// client choked on the empty body.
#[tokio::test(start_paused = true)]
async fn star_succeeds_when_batch_modify_returns_204_with_no_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/message-a"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "message-a", "threadId": "thread-a", "historyId": "20",
            "labelIds": ["INBOX", "STARRED"], "snippet": "updated",
            "internalDate": "1", "payload": { "headers": [] }
        })))
        .mount(&server)
        .await;
    let (storage, _directory) = seed_two_threads();
    let registry = WorkRegistry::new();
    let queue = create_queue_engine_with_events(
        1_000,
        1_000,
        Arc::clone(&registry),
        Arc::new(|_event, _payload| {}),
    );
    let engine = SyncEngine::new(
        storage.clone(),
        Arc::clone(&queue),
        registry,
        noop_event_sink(),
    );

    engine
        .mutate_thread(
            "account",
            GmailClient::with_base_url("token", server.uri()),
            "thread-a".into(),
            "STARRED",
            true,
        )
        .await
        .unwrap();

    let connection = storage.connection().unwrap();
    let message = &MessageRepository::list_by_thread(&connection, "account", "thread-a").unwrap()[0];
    assert!(message.is_starred);
    assert_eq!(message.history_id, 20);
}

/// A rejected `batchModify` has to reach the caller as the Gmail failure it
/// is; the batch's shared reply channels used to be dropped instead, turning
/// every mutation error into "sync queue is no longer accepting work".
#[tokio::test(start_paused = true)]
async fn rejected_batch_modify_reports_the_gmail_error_to_every_waiter() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(403))
        .mount(&server)
        .await;
    let (storage, _directory) = seed_two_threads();
    let registry = WorkRegistry::new();
    let queue = create_queue_engine_with_events(
        1_000,
        1_000,
        Arc::clone(&registry),
        Arc::new(|_event, _payload| {}),
    );
    let engine = SyncEngine::new(storage, Arc::clone(&queue), registry, noop_event_sink());

    let stars = ["thread-a", "thread-b"].map(|thread_id| {
        let engine = Arc::clone(&engine);
        let base_url = server.uri();
        tokio::spawn(async move {
            engine
                .mutate_thread(
                    "account",
                    GmailClient::with_base_url("token", base_url),
                    thread_id.into(),
                    "STARRED",
                    true,
                )
                .await
        })
    });
    for star in stars {
        let error = star.await.unwrap().unwrap_err().to_string();
        assert!(error.contains("403"), "unexpected error: {error}");
    }
}
