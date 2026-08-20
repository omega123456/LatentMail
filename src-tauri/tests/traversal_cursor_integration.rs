use std::sync::{Arc, Mutex};

use latentmail_lib::gmail::GmailClient;
use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, MessageRepository, Storage, TraversalCursor,
    TraversalCursorRepository, TraversalKind,
};
use latentmail_lib::sync::traversal::run_backfill_step;
use latentmail_lib::sync::{EventSink, SyncEngine, WorkRegistry};
use wiremock::{
    matchers::{method, path, query_param, query_param_is_missing},
    Mock, MockServer, ResponseTemplate,
};

fn temp_storage() -> (Storage, tempfile::TempDir) {
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
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    (storage, directory)
}

fn collecting_sink() -> (EventSink, Arc<Mutex<Vec<serde_json::Value>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink_events = Arc::clone(&events);
    let sink: EventSink = Arc::new(move |_name, payload| {
        sink_events.lock().unwrap().push(payload);
    });
    (sink, events)
}

fn message_json(id: &str, thread_id: &str, history_id: &str, subject: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id, "threadId": thread_id, "historyId": history_id,
        "labelIds": ["TRASH", "STARRED"], "snippet": format!("snippet for {id}"),
        "internalDate": "1000",
        "payload": { "mimeType": "text/plain", "headers": [
            {"name": "From", "value": "Sender <s@example.com>"},
            {"name": "To", "value": "me@example.com"},
            {"name": "Subject", "value": subject}
        ], "body": { "data": "aGVsbG8td29ybGQ" } }
    })
}

async fn mount_profile(server: &MockServer, messages_total: i64) {
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com",
            "messagesTotal": messages_total,
            "threadsTotal": messages_total,
            "historyId": "1"
        })))
        .mount(server)
        .await;
}

#[tokio::test]
async fn active_backfill_pauses_after_a_committed_batch_and_resumes_from_its_cursor() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 0, "threadsTotal": 0, "historyId": "1"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("q", "newer_than:30d"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("q"))
        .and(query_param_is_missing("pageToken"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"messages":[{"id":"m1","threadId":"t1"}],"nextPageToken":"page2"}),
        ))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("q"))
        .and(query_param("pageToken", "page2"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"messages":[{"id":"m2","threadId":"t2"}]})),
        )
        .mount(&server)
        .await;
    for (id, thread) in [("m1", "t1"), ("m2", "t2")] {
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{id}")))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(message_json(id, thread, "10", id)),
            )
            .mount(&server)
            .await;
    }

    let (storage, _directory) = temp_storage();
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let pause_queue = queue.clone();

    let sink: EventSink = Arc::new(move |name, _payload| {
        if name == "sync://traversal" {
            pause_queue.pause();
        }
    });
    let engine = SyncEngine::new(storage.clone(), queue.clone(), registry, sink);
    let client = GmailClient::with_base_url("token", server.uri());
    engine.initial_sync("account", client).await.unwrap();

    let mut cursor = None;
    for _ in 0..1_000 {
        cursor = storage
            .run(|connection| {
                TraversalCursorRepository::get(connection, "account", TraversalKind::Backfill)
            })
            .await
            .unwrap();
        if matches!(cursor, Some(ref cursor) if cursor.position.as_deref() == Some("page2")) {
            break;
        }
        tokio::task::yield_now().await;
    }
    let cursor = cursor.expect("backfill must have committed page 1");
    assert_eq!(cursor.position.as_deref(), Some("page2"));
    assert!(!cursor.completed);

    assert!(
        !cursor.resumed,
        "page 2 of a fresh, uninterrupted run must not read as resumed"
    );

    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
    let still_paused_cursor = storage
        .run(|connection| {
            TraversalCursorRepository::get(connection, "account", TraversalKind::Backfill)
        })
        .await
        .unwrap()
        .unwrap();
    assert!(
        !still_paused_cursor.completed,
        "the second page must wait for resume"
    );
    assert_eq!(still_paused_cursor.position.as_deref(), Some("page2"));

    queue.resume();

    let mut completed = false;
    for _ in 0..1_000 {
        let cursor = storage
            .run(|connection| {
                TraversalCursorRepository::get(connection, "account", TraversalKind::Backfill)
            })
            .await
            .unwrap()
            .unwrap();
        if cursor.completed {
            completed = true;
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(completed, "backfill must complete once resumed");
    let final_cursor = storage
        .run(|connection| {
            TraversalCursorRepository::get(connection, "account", TraversalKind::Backfill)
        })
        .await
        .unwrap()
        .unwrap();
    assert!(
        !final_cursor.resumed,
        "a fresh run's final page must still read as not-resumed"
    );
}

#[tokio::test]
async fn restarted_backfill_run_reports_resumed_on_every_page_of_that_run() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 0, "threadsTotal": 0, "historyId": "1"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("q", "newer_than:30d"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("q"))
        .and(query_param("pageToken", "page2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"messages":[{"id":"m2","threadId":"t2"}],"nextPageToken":"page3"}),
        ))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("q"))
        .and(query_param("pageToken", "page3"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"messages":[{"id":"m3","threadId":"t3"}]})),
        )
        .mount(&server)
        .await;
    for (id, thread) in [("m2", "t2"), ("m3", "t3")] {
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{id}")))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(message_json(id, thread, "10", id)),
            )
            .mount(&server)
            .await;
    }

    let (storage, _directory) = temp_storage();

    storage
        .run(|connection| {
            TraversalCursorRepository::upsert(
                connection,
                &TraversalCursor {
                    account_id: "account".into(),
                    kind: TraversalKind::Backfill,
                    position: Some("page2".into()),
                    discovered_count: 1,
                    persisted_count: 1,
                    completed: false,
                    last_advanced_at: 1,
                    resumed: false,
                },
            )
        })
        .await
        .unwrap();

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let pause_queue = queue.clone();
    let pauses = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let sink_pauses = Arc::clone(&pauses);
    let sink: EventSink = Arc::new(move |name, _payload| {
        if name == "sync://traversal" {
            pause_queue.pause();
            sink_pauses.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    });
    let engine = SyncEngine::new(storage.clone(), queue.clone(), registry, sink);
    let client = GmailClient::with_base_url("token", server.uri());
    engine.initial_sync("account", client).await.unwrap();

    let mut cursor = None;
    for _ in 0..1_000 {
        cursor = storage
            .run(|connection| {
                TraversalCursorRepository::get(connection, "account", TraversalKind::Backfill)
            })
            .await
            .unwrap();
        let paused = pauses.load(std::sync::atomic::Ordering::SeqCst) >= 1;
        let at_page3 =
            matches!(cursor, Some(ref cursor) if cursor.position.as_deref() == Some("page3"));
        if at_page3 && paused {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    let cursor = cursor.expect("this run's first page must have committed");
    assert_eq!(cursor.position.as_deref(), Some("page3"));
    assert!(
        cursor.resumed,
        "page 1 of a resumed run must read as resumed"
    );

    queue.resume();

    let mut final_cursor = None;
    for _ in 0..1_000 {
        let candidate = storage
            .run(|connection| {
                TraversalCursorRepository::get(connection, "account", TraversalKind::Backfill)
            })
            .await
            .unwrap()
            .unwrap();
        if candidate.completed {
            final_cursor = Some(candidate);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    let final_cursor = final_cursor.expect("backfill must complete");
    assert!(
        final_cursor.resumed,
        "page 2+ of the same resumed run must still read as resumed, not flip back"
    );
}

#[tokio::test]
async fn backfill_enumeration_has_no_label_filter_no_date_bound_and_includes_spam_and_trash() {
    let server = MockServer::start().await;
    mount_profile(&server, 1).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("labelIds"))
        .and(query_param_is_missing("q"))
        .and(query_param("includeSpamTrash", "true"))
        .and(query_param("maxResults", "500"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m1", "threadId": "t1"}]
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json("m1", "t1", "10", "Hello")),
        )
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage();
    let client = GmailClient::with_base_url("token", server.uri());

    run_backfill_step(
        &storage,
        &client.traversal_scoped(),
        "account",
        &latentmail_lib::sync::noop_event_sink(),
        false,
        None,
    )
    .await
    .unwrap();

    server.verify().await;
}

#[tokio::test]
async fn persisted_messages_carry_metadata_membership_and_truncated_body_only() {
    let server = MockServer::start().await;
    mount_profile(&server, 1).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m1", "threadId": "t1"}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json("m1", "t1", "10", "Hello")),
        )
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage();
    let client = GmailClient::with_base_url("token", server.uri());
    run_backfill_step(
        &storage,
        &client.traversal_scoped(),
        "account",
        &latentmail_lib::sync::noop_event_sink(),
        false,
        None,
    )
    .await
    .unwrap();

    let connection = storage.connection().unwrap();
    let message = MessageRepository::get(&connection, "account", "m1")
        .unwrap()
        .unwrap();
    assert_eq!(message.subject, "Hello");
    assert_eq!(message.truncated_body.as_deref(), Some("hello-world"));
    assert_eq!(
        message.html_body, None,
        "traversal must never persist full HTML"
    );
    assert_eq!(
        message.plain_body, None,
        "traversal must never persist a full plain body"
    );
    assert_eq!(message.html_presence, HtmlPresence::NeverFetched);
    assert!(message.is_starred);
    let label_ids = MessageRepository::label_ids(&connection, "account", "m1").unwrap();
    assert_eq!(label_ids, vec!["STARRED".to_owned(), "TRASH".to_owned()]);
}

#[tokio::test]
async fn interrupted_backfill_resumes_from_the_last_completed_batch() {
    let server = MockServer::start().await;
    mount_profile(&server, 2).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("pageToken"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m1", "threadId": "t1"}],
            "nextPageToken": "page2"
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("pageToken", "page2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m2", "threadId": "t2"}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json("m1", "t1", "10", "First")),
        )
        .expect(1)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/users/me/messages/m2"))
        .respond_with(ResponseTemplate::new(403))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m2"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json("m2", "t2", "20", "Second")),
        )
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage();
    let client = GmailClient::with_base_url("token", server.uri()).traversal_scoped();

    let page_one = run_backfill_step(
        &storage,
        &client,
        "account",
        &latentmail_lib::sync::noop_event_sink(),
        false,
        None,
    )
    .await;
    assert!(page_one.is_ok(), "page 1 must commit cleanly");
    assert!(!page_one.unwrap(), "page 1 alone is not the whole backfill");

    let page_two = run_backfill_step(
        &storage,
        &client,
        "account",
        &latentmail_lib::sync::noop_event_sink(),
        false,
        None,
    )
    .await;
    assert!(
        page_two.is_err(),
        "page 2's message fetch was mocked to fail"
    );

    let connection = storage.connection().unwrap();
    let cursor = TraversalCursorRepository::get(&connection, "account", TraversalKind::Backfill)
        .unwrap()
        .unwrap();
    assert_eq!(cursor.position.as_deref(), Some("page2"));
    assert_eq!(cursor.discovered_count, 2);
    assert_eq!(cursor.persisted_count, 1);
    assert!(!cursor.completed);
    drop(connection);

    let second_attempt = run_backfill_step(
        &storage,
        &client,
        "account",
        &latentmail_lib::sync::noop_event_sink(),
        false,
        None,
    )
    .await;
    assert!(second_attempt.unwrap(), "the resumed page is the last one");

    let connection = storage.connection().unwrap();
    let cursor = TraversalCursorRepository::get(&connection, "account", TraversalKind::Backfill)
        .unwrap()
        .unwrap();
    assert!(cursor.completed);
    assert_eq!(cursor.discovered_count, 2);
    assert_eq!(cursor.persisted_count, 2);
    assert!(MessageRepository::get(&connection, "account", "m1")
        .unwrap()
        .is_some());
    assert!(MessageRepository::get(&connection, "account", "m2")
        .unwrap()
        .is_some());

    server.verify().await;
}

#[tokio::test(start_paused = true)]
async fn a_second_enqueue_backfill_call_is_a_no_op_while_a_chain_is_already_in_flight() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 0, "threadsTotal": 0, "historyId": "1"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("q", "newer_than:30d"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("q"))
        .and(query_param_is_missing("pageToken"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"messages":[{"id":"m1","threadId":"t1"}],"nextPageToken":"page2"}),
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("q"))
        .and(query_param("pageToken", "page2"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"messages":[{"id":"m2","threadId":"t2"}]})),
        )
        .expect(1)
        .mount(&server)
        .await;
    for (id, thread) in [("m1", "t1"), ("m2", "t2")] {
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{id}")))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(message_json(id, thread, "10", id)),
            )
            .mount(&server)
            .await;
    }

    let (storage, _directory) = temp_storage();
    let registry = WorkRegistry::new();

    let queue_events = Arc::new(Mutex::new(Vec::new()));
    let sink_events = Arc::clone(&queue_events);
    let queue = latentmail_lib::sync::create_queue_engine_with_events(
        250,
        250,
        registry.clone(),
        Arc::new(move |name, payload| {
            if name == "queue://item" {
                sink_events.lock().unwrap().push(payload);
            }
        }),
    );
    let pause_queue = queue.clone();

    let sink: EventSink = Arc::new(move |name, _payload| {
        if name == "sync://traversal" {
            pause_queue.pause();
        }
    });
    let engine = SyncEngine::new(storage.clone(), queue.clone(), registry, sink);
    let client = GmailClient::with_base_url("token", server.uri());

    engine
        .initial_sync("account", client.clone())
        .await
        .unwrap();

    let distinct_traversal_ops = || {
        let count = queue_events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event["status"] == "done")
            .filter_map(|event| event["id"].as_str())
            .filter(|id| id.starts_with("traversal:account:"))
            .map(str::to_owned)
            .collect::<std::collections::HashSet<_>>()
            .len();
        count
    };

    let mut cursor = None;
    for _ in 0..1_000 {
        cursor = storage
            .run(|connection| {
                TraversalCursorRepository::get(connection, "account", TraversalKind::Backfill)
            })
            .await
            .unwrap();
        if matches!(cursor, Some(ref cursor) if cursor.position.as_deref() == Some("page2"))
            && distinct_traversal_ops() == 1
        {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(
        cursor
            .expect("page 1 must have committed and its operation must settle")
            .position
            .as_deref(),
        Some("page2")
    );
    assert_eq!(
        distinct_traversal_ops(),
        1,
        "only page 1 has completed so far"
    );

    engine.enqueue_backfill("account", client.clone()).await;

    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        distinct_traversal_ops(),
        1,
        "a second enqueue_backfill call while the first chain is in-flight must not start a new chain"
    );

    queue.resume();
    let mut completed = false;
    for _ in 0..1_000 {
        let cursor = storage
            .run(|connection| {
                TraversalCursorRepository::get(connection, "account", TraversalKind::Backfill)
            })
            .await
            .unwrap()
            .unwrap();
        if cursor.completed && distinct_traversal_ops() == 2 {
            completed = true;
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(completed, "the first (only) chain must complete");
    assert_eq!(
        distinct_traversal_ops(),
        2,
        "the completed chain must be exactly the original two pages — no interleaved third op"
    );
    server.verify().await;

    queue.resume();
    engine.enqueue_backfill("account", client).await;
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        distinct_traversal_ops(),
        2,
        "a completed cursor must make enqueue_backfill a no-op rather than queue an operation that only re-reads it"
    );
}

#[tokio::test(start_paused = true)]
async fn enqueue_backfill_still_starts_a_chain_when_the_cursor_stopped_short_of_completion() {
    let server = MockServer::start().await;
    mount_profile(&server, 1).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("pageToken", "page2"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"messages":[{"id":"m2","threadId":"t2"}]})),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m2"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json("m2", "t2", "20", "Second")),
        )
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage();
    storage
        .run(|connection| {
            TraversalCursorRepository::upsert(
                connection,
                &TraversalCursor {
                    account_id: "account".to_owned(),
                    kind: TraversalKind::Backfill,
                    position: Some("page2".to_owned()),
                    discovered_count: 2,
                    persisted_count: 1,
                    completed: false,
                    last_advanced_at: 0,
                    resumed: false,
                },
            )
        })
        .await
        .unwrap();

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(
        storage.clone(),
        queue,
        registry,
        latentmail_lib::sync::noop_event_sink(),
    );

    engine
        .enqueue_backfill("account", GmailClient::with_base_url("token", server.uri()))
        .await;

    let mut completed = false;
    for _ in 0..1_000 {
        let cursor = storage
            .run(|connection| {
                TraversalCursorRepository::get(connection, "account", TraversalKind::Backfill)
            })
            .await
            .unwrap()
            .unwrap();
        if cursor.completed {
            completed = true;
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        completed,
        "an unfinished cursor must still be resumed by enqueue_backfill"
    );
}

#[tokio::test]
async fn backfill_runs_normally_alongside_an_unrelated_reconciliation_cursor_row() {
    let server = MockServer::start().await;
    mount_profile(&server, 1).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m1", "threadId": "t1"}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json("m1", "t1", "10", "Hello")),
        )
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage();
    storage
        .run(|connection| {
            TraversalCursorRepository::upsert(
                connection,
                &TraversalCursor {
                    account_id: "account".into(),
                    kind: TraversalKind::Reconciliation,
                    position: Some("in-progress".into()),
                    discovered_count: 3,
                    persisted_count: 3,
                    completed: false,
                    last_advanced_at: 1,
                    resumed: false,
                },
            )
        })
        .await
        .unwrap();

    let client = GmailClient::with_base_url("token", server.uri()).traversal_scoped();

    run_backfill_step(
        &storage,
        &client,
        "account",
        &latentmail_lib::sync::noop_event_sink(),
        false,
        None,
    )
    .await
    .unwrap();

    let connection = storage.connection().unwrap();
    let backfill_cursor =
        TraversalCursorRepository::get(&connection, "account", TraversalKind::Backfill)
            .unwrap()
            .unwrap();
    assert!(
        backfill_cursor.completed,
        "backfill must run to completion, not silently no-op"
    );
    assert_eq!(backfill_cursor.discovered_count, 1);

    let reconciliation_cursor =
        TraversalCursorRepository::get(&connection, "account", TraversalKind::Reconciliation)
            .unwrap()
            .unwrap();
    assert_eq!(
        reconciliation_cursor.position.as_deref(),
        Some("in-progress")
    );
    assert_eq!(reconciliation_cursor.discovered_count, 3);
    assert!(
        !reconciliation_cursor.completed,
        "backfill must not touch reconciliation's own cursor row"
    );
}

#[tokio::test]
async fn backfill_cursor_survives_reconciliation_and_resumes_after_it_completes() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 6, "threadsTotal": 0, "historyId": "50"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("pageToken"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})))
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage();
    storage
        .run(|connection| {
            AccountRepository::upsert(
                connection,
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
        })
        .await
        .unwrap();

    storage
        .run(|connection| {
            TraversalCursorRepository::upsert(
                connection,
                &TraversalCursor {
                    account_id: "account".into(),
                    kind: TraversalKind::Backfill,
                    position: Some("page2".into()),
                    discovered_count: 5,
                    persisted_count: 5,
                    completed: false,
                    last_advanced_at: 1,
                    resumed: false,
                },
            )
        })
        .await
        .unwrap();

    let registry = WorkRegistry::new();
    let engine = SyncEngine::new(
        storage.clone(),
        latentmail_lib::sync::create_queue_engine(250, 250, registry.clone()),
        registry,
        latentmail_lib::sync::noop_event_sink(),
    );
    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    let backfill_cursor = storage
        .run(|connection| {
            TraversalCursorRepository::get(connection, "account", TraversalKind::Backfill)
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(backfill_cursor.position.as_deref(), Some("page2"));
    assert_eq!(backfill_cursor.discovered_count, 5);
    assert_eq!(backfill_cursor.persisted_count, 5);
    assert!(
        !backfill_cursor.completed,
        "reconciliation must not have advanced or completed backfill's cursor"
    );

    let reconciliation_cursor = storage
        .run(|connection| {
            TraversalCursorRepository::get(connection, "account", TraversalKind::Reconciliation)
        })
        .await
        .unwrap()
        .unwrap();
    assert!(reconciliation_cursor.completed);

    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("pageToken", "page2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m1", "threadId": "t1"}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json("m1", "t1", "10", "Hello")),
        )
        .mount(&server)
        .await;

    let client = GmailClient::with_base_url("token", server.uri()).traversal_scoped();

    run_backfill_step(
        &storage,
        &client,
        "account",
        &latentmail_lib::sync::noop_event_sink(),
        true,
        None,
    )
    .await
    .unwrap();

    let resumed_cursor = storage
        .run(|connection| {
            TraversalCursorRepository::get(connection, "account", TraversalKind::Backfill)
        })
        .await
        .unwrap()
        .unwrap();
    assert!(
        resumed_cursor.completed,
        "backfill must resume from its preserved position and complete, not no-op forever"
    );
    assert_eq!(resumed_cursor.discovered_count, 6);
    assert_eq!(resumed_cursor.persisted_count, 6);

    let connection = storage.connection().unwrap();
    assert!(MessageRepository::get(&connection, "account", "m1")
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn fetch_and_persist_writes_messages_and_returns_touched_thread_ids() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json("m1", "t1", "10", "Hello")),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(message_json(
            "m2",
            "t1",
            "11",
            "Hello again",
        )))
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage();
    let client = GmailClient::with_base_url("token", server.uri()).traversal_scoped();

    let mut thread_ids = latentmail_lib::sync::traversal::fetch_and_persist(
        &storage,
        &client,
        "account",
        &["m1".to_owned(), "m2".to_owned()],
        None,
    )
    .await
    .unwrap();
    thread_ids.sort();
    assert_eq!(thread_ids, vec!["t1".to_owned()]);

    let connection = storage.connection().unwrap();
    assert!(MessageRepository::get(&connection, "account", "m1")
        .unwrap()
        .is_some());
    assert!(MessageRepository::get(&connection, "account", "m2")
        .unwrap()
        .is_some());

    assert!(
        TraversalCursorRepository::get(&connection, "account", TraversalKind::Backfill)
            .unwrap()
            .is_none()
    );
    assert!(
        TraversalCursorRepository::get(&connection, "account", TraversalKind::Reconciliation)
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_completed_cursor_is_not_restarted() {
    let server = MockServer::start().await;
    let (storage, _directory) = temp_storage();
    storage
        .run(|connection| {
            TraversalCursorRepository::upsert(
                connection,
                &TraversalCursor {
                    account_id: "account".into(),
                    kind: TraversalKind::Backfill,
                    position: None,
                    discovered_count: 42,
                    persisted_count: 42,
                    completed: true,
                    last_advanced_at: 1,
                    resumed: false,
                },
            )
        })
        .await
        .unwrap();

    let client = GmailClient::with_base_url("token", server.uri()).traversal_scoped();
    run_backfill_step(
        &storage,
        &client,
        "account",
        &latentmail_lib::sync::noop_event_sink(),
        false,
        None,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn progress_events_carry_counts_only_never_a_percentage_or_estimate() {
    let server = MockServer::start().await;
    mount_profile(&server, 50_000).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m1", "threadId": "t1"}],
            "nextPageToken": "page2"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json("m1", "t1", "10", "Hello")),
        )
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage();
    let client = GmailClient::with_base_url("token", server.uri()).traversal_scoped();
    let (sink, events) = collecting_sink();
    run_backfill_step(&storage, &client, "account", &sink, false, None)
        .await
        .unwrap();

    let events = events.lock().unwrap();
    assert_eq!(events.len(), 1);
    let payload = events[0].as_object().unwrap();
    assert_eq!(payload["discoveredCount"], 50_000);
    assert_eq!(payload["persistedCount"], 1);
    assert_eq!(payload["completed"], false);
    for key in payload.keys() {
        assert!(
            !key.to_ascii_lowercase().contains("percent")
                && !key.to_ascii_lowercase().contains("estimate"),
            "progress payload must never carry a percentage or estimate field, found {key}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn initial_sync_completion_enqueues_backfill_which_advances_the_cursor() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 1, "threadsTotal": 1, "historyId": "100"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "labels": [{"id":"INBOX","name":"Inbox","type":"system","messagesTotal":1,"messagesUnread":0}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m1", "threadId": "t1"}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json("m1", "t1", "10", "Hello")),
        )
        .mount(&server)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    {
        let connection = storage.connection().unwrap();
        latentmail_lib::storage::AccountRepository::upsert(
            &connection,
            &latentmail_lib::storage::Account {
                id: "account".into(),
                email: "me@example.com".into(),
                display_name: String::new(),
                avatar_url: None,
                history_id: None,
                needs_reauthentication: false,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
    }
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(
        storage.clone(),
        queue,
        registry,
        latentmail_lib::sync::noop_event_sink(),
    );
    let client = GmailClient::with_base_url("token", server.uri());

    engine.initial_sync("account", client).await.unwrap();

    let mut cursor = None;
    for _ in 0..10_000 {
        cursor = storage
            .run(|connection| {
                TraversalCursorRepository::get(connection, "account", TraversalKind::Backfill)
            })
            .await
            .unwrap();
        if matches!(&cursor, Some(cursor) if cursor.completed) {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        matches!(&cursor, Some(cursor) if cursor.completed),
        "backfill enqueued by initial_sync never completed"
    );
}

#[tokio::test(start_paused = true)]
async fn backfill_advances_as_one_discrete_queue_operation_per_page() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 1, "threadsTotal": 1, "historyId": "100"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "labels": [{"id":"INBOX","name":"Inbox","type":"system","messagesTotal":1,"messagesUnread":0}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("pageToken"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m1", "threadId": "t1"}],
            "nextPageToken": "page2"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("pageToken", "page2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m2", "threadId": "t2"}]
        })))
        .mount(&server)
        .await;
    for id in ["m1", "m2"] {
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(message_json(id, id, "10", id)))
            .mount(&server)
            .await;
    }

    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    {
        let connection = storage.connection().unwrap();
        latentmail_lib::storage::AccountRepository::upsert(
            &connection,
            &latentmail_lib::storage::Account {
                id: "account".into(),
                email: "me@example.com".into(),
                display_name: String::new(),
                avatar_url: None,
                history_id: None,
                needs_reauthentication: false,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
    }
    let registry = WorkRegistry::new();

    let queue_events = Arc::new(Mutex::new(Vec::new()));
    let sink_events = Arc::clone(&queue_events);
    let queue = latentmail_lib::sync::create_queue_engine_with_events(
        250,
        250,
        registry.clone(),
        Arc::new(move |name, payload| {
            if name == "queue://item" {
                sink_events.lock().unwrap().push(payload);
            }
        }),
    );
    let engine = SyncEngine::new(
        storage.clone(),
        queue,
        registry,
        latentmail_lib::sync::noop_event_sink(),
    );
    let client = GmailClient::with_base_url("token", server.uri());

    engine.initial_sync("account", client).await.unwrap();

    let completed_traversal_ops = || {
        queue_events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event["status"] == "done")
            .filter_map(|event| event["id"].as_str())
            .filter(|id| id.starts_with("traversal:account:"))
            .map(str::to_owned)
            .collect::<std::collections::HashSet<_>>()
    };

    let mut cursor = None;
    for _ in 0..10_000 {
        cursor = storage
            .run(|connection| {
                TraversalCursorRepository::get(connection, "account", TraversalKind::Backfill)
            })
            .await
            .unwrap();
        let settled = completed_traversal_ops().len() == 2;
        if matches!(&cursor, Some(cursor) if cursor.completed) && settled {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(matches!(&cursor, Some(cursor) if cursor.completed));

    let distinct_traversal_ops = completed_traversal_ops();
    assert_eq!(
        distinct_traversal_ops.len(),
        2,
        "a two-page backfill must complete as two separately queued traversal \
         operations, not one operation looping internally over both pages: {distinct_traversal_ops:?}"
    );
}
