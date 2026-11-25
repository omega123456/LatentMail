use latentmail_lib::sync::traversal::{BackfillStepContext, FetchPersistRequest};
use latentmail_lib::sync::{EventSink, QueueRateConfig, SyncEngine, SyncEngineDeps, WorkRegistry};
use std::sync::{Arc, Mutex};

use latentmail_lib::gmail::GmailClient;
use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, MessageRepository, Storage, TraversalCursor,
    TraversalCursorRepository, TraversalKind,
};
use latentmail_lib::sync::traversal::run_backfill_step;
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

struct MessageJson<'a> {
    id: &'a str,
    thread_id: &'a str,
    history_id: &'a str,
    subject: &'a str,
}

fn message_json(
    MessageJson {
        id,
        thread_id,
        history_id,
        subject,
    }: MessageJson<'_>,
) -> serde_json::Value {
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

async fn load_cursor(storage: &Storage, kind: TraversalKind) -> Option<TraversalCursor> {
    storage
        .run(move |connection| TraversalCursorRepository::get(connection, "account", kind))
        .await
        .unwrap()
}

async fn save_cursor(storage: &Storage, cursor: TraversalCursor) {
    storage
        .run(move |connection| TraversalCursorRepository::upsert(connection, &cursor))
        .await
        .unwrap();
}

fn pause_on_traversal_sink(queue: Arc<latentmail_lib::queue::QueueEngine>) -> EventSink {
    Arc::new(move |name, _payload| {
        if name == latentmail_lib::events::SYNC_TRAVERSAL {
            queue.pause();
        }
    })
}

fn counting_pause_sink(
    queue: Arc<latentmail_lib::queue::QueueEngine>,
    pauses: Arc<std::sync::atomic::AtomicUsize>,
) -> EventSink {
    Arc::new(move |name, _payload| {
        if name == latentmail_lib::events::SYNC_TRAVERSAL {
            queue.pause();
            pauses.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    })
}

fn queue_item_collector(queue_events: Arc<Mutex<Vec<serde_json::Value>>>) -> EventSink {
    Arc::new(move |name, payload| {
        if name == latentmail_lib::events::QUEUE_ITEM {
            queue_events.lock().unwrap().push(payload);
        }
    })
}

fn completed_traversal_op_ids(
    queue_events: &Arc<Mutex<Vec<serde_json::Value>>>,
) -> std::collections::HashSet<String> {
    queue_events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event["status"] == "done")
        .filter_map(|event| event["id"].as_str())
        .filter(|id| id.starts_with("traversal:account:"))
        .map(str::to_owned)
        .collect()
}

async fn wait_for_cursor_position(storage: &Storage, expected: &str) -> Option<TraversalCursor> {
    for _ in 0..1_000 {
        let cursor = load_cursor(storage, TraversalKind::Backfill).await;
        if cursor.as_ref().and_then(|value| value.position.as_deref()) == Some(expected) {
            return cursor;
        }
        tokio::task::yield_now().await;
    }
    None
}

async fn wait_for_cursor_completed(storage: &Storage, max_polls: usize) -> Option<TraversalCursor> {
    for _ in 0..max_polls {
        let cursor = load_cursor(storage, TraversalKind::Backfill).await;
        if cursor.as_ref().is_some_and(|value| value.completed) {
            return cursor;
        }
        tokio::task::yield_now().await;
    }
    None
}

async fn wait_for_resumed_page(
    storage: &Storage,
    pauses: &std::sync::atomic::AtomicUsize,
    expected: &str,
) -> Option<TraversalCursor> {
    for _ in 0..1_000 {
        let cursor = load_cursor(storage, TraversalKind::Backfill).await;
        let paused = pauses.load(std::sync::atomic::Ordering::SeqCst) >= 1;
        let at_page = cursor.as_ref().and_then(|value| value.position.as_deref()) == Some(expected);
        if at_page && paused {
            return cursor;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    None
}

async fn wait_for_completed_with_sleep(storage: &Storage) -> Option<TraversalCursor> {
    for _ in 0..1_000 {
        let candidate = load_cursor(storage, TraversalKind::Backfill).await.unwrap();
        if candidate.completed {
            return Some(candidate);
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    None
}

async fn wait_for_page_and_single_op(
    storage: &Storage,
    queue_events: &Arc<Mutex<Vec<serde_json::Value>>>,
    expected: &str,
) -> Option<TraversalCursor> {
    for _ in 0..1_000 {
        let cursor = load_cursor(storage, TraversalKind::Backfill).await;
        let at_page = cursor.as_ref().and_then(|value| value.position.as_deref()) == Some(expected);
        if at_page && completed_traversal_op_ids(queue_events).len() == 1 {
            return cursor;
        }
        tokio::task::yield_now().await;
    }
    None
}

async fn wait_for_completed_and_ops(
    storage: &Storage,
    queue_events: &Arc<Mutex<Vec<serde_json::Value>>>,
    expected_ops: usize,
) -> Option<TraversalCursor> {
    for _ in 0..10_000 {
        let cursor = load_cursor(storage, TraversalKind::Backfill).await;
        let done = cursor.as_ref().is_some_and(|value| value.completed);
        if done && completed_traversal_op_ids(queue_events).len() == expected_ops {
            return cursor;
        }
        tokio::task::yield_now().await;
    }
    None
}

async fn mount_empty_initial_sync_scaffold(server: &MockServer) {
    mount_profile(server, 0).await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("q", "newer_than:30d"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})))
        .mount(server)
        .await;
}

async fn mount_backfill_page(server: &MockServer, page: Mock, expect_once: bool) {
    if expect_once {
        page.expect(1).mount(server).await;
        return;
    }
    page.mount(server).await;
}

async fn mount_two_page_backfill_mocks(server: &MockServer, expect_once: bool) {
    mount_empty_initial_sync_scaffold(server).await;
    let first_page = Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("q"))
        .and(query_param_is_missing("pageToken"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"messages":[{"id":"m1","threadId":"t1"}],"nextPageToken":"page2"}),
        ));
    mount_backfill_page(server, first_page, expect_once).await;
    let second_page = Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("q"))
        .and(query_param("pageToken", "page2"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"messages":[{"id":"m2","threadId":"t2"}]})),
        );
    mount_backfill_page(server, second_page, expect_once).await;
    for (id, thread) in [("m1", "t1"), ("m2", "t2")] {
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{id}")))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                    id: id,
                    thread_id: thread,
                    history_id: "10",
                    subject: id,
                })),
            )
            .mount(server)
            .await;
    }
}

async fn step_backfill(
    storage: &Storage,
    client: &GmailClient,
    resumed: bool,
) -> Result<bool, latentmail_lib::sync::SyncError> {
    run_backfill_step(BackfillStepContext {
        storage: storage,
        client: client,
        account_id: "account",
        events: &latentmail_lib::sync::noop_event_sink(),
        resumed: resumed,
        cache: None,
    })
    .await
}

#[tokio::test]
async fn active_backfill_pauses_after_a_committed_batch_and_resumes_from_its_cursor() {
    let server = MockServer::start().await;
    mount_two_page_backfill_mocks(&server, false).await;

    let (storage, _directory) = temp_storage();
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(SyncEngineDeps {
        storage: storage.clone(),
        queue: queue.clone(),
        registry: registry,
        events: pause_on_traversal_sink(queue.clone()),
    });
    let client = GmailClient::with_base_url("token", server.uri());
    engine.initial_sync("account", client).await.unwrap();

    let cursor = wait_for_cursor_position(&storage, "page2")
        .await
        .expect("backfill must have committed page 1");
    assert_eq!(cursor.position.as_deref(), Some("page2"));
    assert!(!cursor.completed);
    assert!(
        !cursor.resumed,
        "page 2 of a fresh, uninterrupted run must not read as resumed"
    );

    let_spawned_tasks_settle().await;
    let still_paused_cursor = load_cursor(&storage, TraversalKind::Backfill)
        .await
        .unwrap();
    assert!(
        !still_paused_cursor.completed,
        "the second page must wait for resume"
    );
    assert_eq!(still_paused_cursor.position.as_deref(), Some("page2"));

    queue.resume();

    let final_cursor = wait_for_cursor_completed(&storage, 1_000)
        .await
        .expect("backfill must complete once resumed");
    assert!(
        !final_cursor.resumed,
        "a fresh run's final page must still read as not-resumed"
    );
}

async fn mount_resumed_two_page_mocks(server: &MockServer) {
    mount_empty_initial_sync_scaffold(server).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("q"))
        .and(query_param("pageToken", "page2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"messages":[{"id":"m2","threadId":"t2"}],"nextPageToken":"page3"}),
        ))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("q"))
        .and(query_param("pageToken", "page3"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"messages":[{"id":"m3","threadId":"t3"}]})),
        )
        .mount(server)
        .await;
    for (id, thread) in [("m2", "t2"), ("m3", "t3")] {
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{id}")))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                    id: id,
                    thread_id: thread,
                    history_id: "10",
                    subject: id,
                })),
            )
            .mount(server)
            .await;
    }
}

#[tokio::test]
async fn restarted_backfill_run_reports_resumed_on_every_page_of_that_run() {
    let server = MockServer::start().await;
    mount_resumed_two_page_mocks(&server).await;

    let (storage, _directory) = temp_storage();
    save_cursor(
        &storage,
        TraversalCursor {
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
    .await;

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let pauses = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let engine = SyncEngine::new(SyncEngineDeps {
        storage: storage.clone(),
        queue: queue.clone(),
        registry: registry,
        events: counting_pause_sink(queue.clone(), Arc::clone(&pauses)),
    });
    let client = GmailClient::with_base_url("token", server.uri());
    engine.initial_sync("account", client).await.unwrap();

    let cursor = wait_for_resumed_page(&storage, &pauses, "page3")
        .await
        .expect("this run's first page must have committed");
    assert_eq!(cursor.position.as_deref(), Some("page3"));
    assert!(
        cursor.resumed,
        "page 1 of a resumed run must read as resumed"
    );

    queue.resume();

    let final_cursor = wait_for_completed_with_sleep(&storage)
        .await
        .expect("backfill must complete");
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
            ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                id: "m1",
                thread_id: "t1",
                history_id: "10",
                subject: "Hello",
            })),
        )
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage();
    let client = GmailClient::with_base_url("token", server.uri());

    run_backfill_step(BackfillStepContext {
        storage: &storage,
        client: &client.traversal_scoped(),
        account_id: "account",
        events: &latentmail_lib::sync::noop_event_sink(),
        resumed: false,
        cache: None,
    })
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
            ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                id: "m1",
                thread_id: "t1",
                history_id: "10",
                subject: "Hello",
            })),
        )
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage();
    let client = GmailClient::with_base_url("token", server.uri());
    run_backfill_step(BackfillStepContext {
        storage: &storage,
        client: &client.traversal_scoped(),
        account_id: "account",
        events: &latentmail_lib::sync::noop_event_sink(),
        resumed: false,
        cache: None,
    })
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

async fn mount_interrupted_backfill_mocks(server: &MockServer) {
    mount_profile(server, 2).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("pageToken"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m1", "threadId": "t1"}],
            "nextPageToken": "page2"
        })))
        .expect(1)
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("pageToken", "page2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m2", "threadId": "t2"}]
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                id: "m1",
                thread_id: "t1",
                history_id: "10",
                subject: "First",
            })),
        )
        .expect(1)
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m2"))
        .respond_with(ResponseTemplate::new(403))
        .up_to_n_times(1)
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m2"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                id: "m2",
                thread_id: "t2",
                history_id: "20",
                subject: "Second",
            })),
        )
        .mount(server)
        .await;
}

#[tokio::test]
async fn interrupted_backfill_resumes_from_the_last_completed_batch() {
    let server = MockServer::start().await;
    mount_interrupted_backfill_mocks(&server).await;

    let (storage, _directory) = temp_storage();
    let client = GmailClient::with_base_url("token", server.uri()).traversal_scoped();

    let page_one = step_backfill(&storage, &client, false).await;
    assert!(page_one.is_ok(), "page 1 must commit cleanly");
    assert!(!page_one.unwrap(), "page 1 alone is not the whole backfill");

    let page_two = step_backfill(&storage, &client, false).await;
    assert!(
        page_two.is_err(),
        "page 2's message fetch was mocked to fail"
    );

    let cursor = load_cursor(&storage, TraversalKind::Backfill)
        .await
        .unwrap();
    assert_eq!(cursor.position.as_deref(), Some("page2"));
    assert_eq!(cursor.discovered_count, 2);
    assert_eq!(cursor.persisted_count, 1);
    assert!(!cursor.completed);

    let second_attempt = step_backfill(&storage, &client, false).await;
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

const SETTLING_YIELDS: usize = 200;

async fn let_spawned_tasks_settle() {
    for _ in 0..SETTLING_YIELDS {
        tokio::task::yield_now().await;
    }
}

struct PausingTraversalEngine {
    engine: Arc<SyncEngine>,
    queue: Arc<latentmail_lib::queue::QueueEngine>,
}

fn build_pausing_traversal_engine(
    storage: &Storage,
    queue_events: &Arc<Mutex<Vec<serde_json::Value>>>,
) -> PausingTraversalEngine {
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine_with_events(
        QueueRateConfig {
            rate_per_second: 250,
            burst: 250,
        },
        registry.clone(),
        queue_item_collector(Arc::clone(queue_events)),
    );
    let engine = SyncEngine::new(SyncEngineDeps {
        storage: storage.clone(),
        queue: queue.clone(),
        registry: registry,
        events: pause_on_traversal_sink(queue.clone()),
    });
    PausingTraversalEngine {
        engine: engine,
        queue: queue,
    }
}

#[tokio::test(start_paused = true)]
async fn a_second_enqueue_backfill_call_is_a_no_op_while_a_chain_is_already_in_flight() {
    let server = MockServer::start().await;
    mount_two_page_backfill_mocks(&server, true).await;

    let (storage, _directory) = temp_storage();
    let queue_events = Arc::new(Mutex::new(Vec::new()));
    let PausingTraversalEngine { engine, queue } =
        build_pausing_traversal_engine(&storage, &queue_events);
    let client = GmailClient::with_base_url("token", server.uri());
    engine
        .initial_sync("account", client.clone())
        .await
        .unwrap();

    let cursor = wait_for_page_and_single_op(&storage, &queue_events, "page2")
        .await
        .expect("page 1 must have committed and its operation must settle");
    assert_eq!(cursor.position.as_deref(), Some("page2"));
    assert_eq!(
        completed_traversal_op_ids(&queue_events).len(),
        1,
        "only page 1 has completed so far"
    );

    engine.enqueue_backfill("account", client.clone()).await;
    let_spawned_tasks_settle().await;
    assert_eq!(
        completed_traversal_op_ids(&queue_events).len(),
        1,
        "a second enqueue_backfill call while the first chain is in-flight must not start a new chain"
    );

    queue.resume();
    assert!(
        wait_for_completed_and_ops(&storage, &queue_events, 2)
            .await
            .is_some(),
        "the first (only) chain must complete"
    );
    assert_eq!(
        completed_traversal_op_ids(&queue_events).len(),
        2,
        "the completed chain must be exactly the original two pages — no interleaved third op"
    );
    server.verify().await;

    queue.resume();
    engine.enqueue_backfill("account", client).await;
    let_spawned_tasks_settle().await;
    assert_eq!(
        completed_traversal_op_ids(&queue_events).len(),
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
            ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                id: "m2",
                thread_id: "t2",
                history_id: "20",
                subject: "Second",
            })),
        )
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage();
    save_cursor(
        &storage,
        TraversalCursor {
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
    .await;

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(SyncEngineDeps {
        storage: storage.clone(),
        queue: queue,
        registry: registry,
        events: latentmail_lib::sync::noop_event_sink(),
    });
    engine
        .enqueue_backfill("account", GmailClient::with_base_url("token", server.uri()))
        .await;

    assert!(
        wait_for_cursor_completed(&storage, 1_000).await.is_some(),
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
            ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                id: "m1",
                thread_id: "t1",
                history_id: "10",
                subject: "Hello",
            })),
        )
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage();
    save_cursor(
        &storage,
        TraversalCursor {
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
    .await;

    let client = GmailClient::with_base_url("token", server.uri()).traversal_scoped();
    step_backfill(&storage, &client, false).await.unwrap();

    let backfill_cursor = load_cursor(&storage, TraversalKind::Backfill)
        .await
        .unwrap();
    assert!(
        backfill_cursor.completed,
        "backfill must run to completion, not silently no-op"
    );
    assert_eq!(backfill_cursor.discovered_count, 1);

    let reconciliation_cursor = load_cursor(&storage, TraversalKind::Reconciliation)
        .await
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

async fn mount_reconciliation_then_backfill_mocks(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(404))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 6, "threadsTotal": 0, "historyId": "50"
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("pageToken"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})))
        .mount(server)
        .await;
}

async fn mount_backfill_page_two_mock(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("pageToken", "page2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m1", "threadId": "t1"}]
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                id: "m1",
                thread_id: "t1",
                history_id: "10",
                subject: "Hello",
            })),
        )
        .mount(server)
        .await;
}

async fn seed_account_with_half_done_backfill(storage: &Storage) {
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
    save_cursor(
        storage,
        TraversalCursor {
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
    .await;
}

async fn assert_reconciliation_left_backfill_untouched(storage: &Storage) {
    let backfill_cursor = load_cursor(storage, TraversalKind::Backfill).await.unwrap();
    assert_eq!(backfill_cursor.position.as_deref(), Some("page2"));
    assert_eq!(backfill_cursor.discovered_count, 5);
    assert_eq!(backfill_cursor.persisted_count, 5);
    assert!(
        !backfill_cursor.completed,
        "reconciliation must not have advanced or completed backfill's cursor"
    );
    assert!(
        load_cursor(storage, TraversalKind::Reconciliation)
            .await
            .unwrap()
            .completed
    );
}

#[tokio::test]
async fn backfill_cursor_survives_reconciliation_and_resumes_after_it_completes() {
    let server = MockServer::start().await;
    mount_reconciliation_then_backfill_mocks(&server).await;

    let (storage, _directory) = temp_storage();
    seed_account_with_half_done_backfill(&storage).await;

    let registry = WorkRegistry::new();
    let engine = SyncEngine::new(SyncEngineDeps {
        storage: storage.clone(),
        queue: latentmail_lib::sync::create_queue_engine(250, 250, registry.clone()),
        registry: registry,
        events: latentmail_lib::sync::noop_event_sink(),
    });
    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    assert_reconciliation_left_backfill_untouched(&storage).await;

    mount_backfill_page_two_mock(&server).await;
    let client = GmailClient::with_base_url("token", server.uri()).traversal_scoped();
    step_backfill(&storage, &client, true).await.unwrap();

    let resumed_cursor = load_cursor(&storage, TraversalKind::Backfill)
        .await
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
            ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                id: "m1",
                thread_id: "t1",
                history_id: "10",
                subject: "Hello",
            })),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m2"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                id: "m2",
                thread_id: "t1",
                history_id: "11",
                subject: "Hello again",
            })),
        )
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage();
    let client = GmailClient::with_base_url("token", server.uri()).traversal_scoped();

    let mut thread_ids = latentmail_lib::sync::traversal::fetch_and_persist(FetchPersistRequest {
        storage: &storage,
        client: &client,
        account_id: "account",
        ids: &["m1".to_owned(), "m2".to_owned()],
        cache: None,
    })
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
    run_backfill_step(BackfillStepContext {
        storage: &storage,
        client: &client,
        account_id: "account",
        events: &latentmail_lib::sync::noop_event_sink(),
        resumed: false,
        cache: None,
    })
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
            ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                id: "m1",
                thread_id: "t1",
                history_id: "10",
                subject: "Hello",
            })),
        )
        .mount(&server)
        .await;

    let (storage, _directory) = temp_storage();
    let client = GmailClient::with_base_url("token", server.uri()).traversal_scoped();
    let (sink, events) = collecting_sink();
    run_backfill_step(BackfillStepContext {
        storage: &storage,
        client: &client,
        account_id: "account",
        events: &sink,
        resumed: false,
        cache: None,
    })
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

async fn mount_initial_sync_inbox_mocks(server: &MockServer, two_pages: bool) {
    mount_profile_and_inbox_label(server).await;
    if !two_pages {
        mount_single_inbox_page(server).await;
        return;
    }
    mount_two_inbox_pages(server).await;
}

async fn mount_profile_and_inbox_label(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 1, "threadsTotal": 1, "historyId": "100"
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "labels": [{"id":"INBOX","name":"Inbox","type":"system","messagesTotal":1,"messagesUnread":0}]
        })))
        .mount(server)
        .await;
}

async fn mount_single_inbox_page(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m1", "threadId": "t1"}]
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                id: "m1",
                thread_id: "t1",
                history_id: "10",
                subject: "Hello",
            })),
        )
        .mount(server)
        .await;
}

async fn mount_two_inbox_pages(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("pageToken"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m1", "threadId": "t1"}],
            "nextPageToken": "page2"
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("pageToken", "page2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "m2", "threadId": "t2"}]
        })))
        .mount(server)
        .await;
    for id in ["m1", "m2"] {
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{id}")))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                    id: id,
                    thread_id: id,
                    history_id: "10",
                    subject: id,
                })),
            )
            .mount(server)
            .await;
    }
}

#[tokio::test(start_paused = true)]
async fn initial_sync_completion_enqueues_backfill_which_advances_the_cursor() {
    let server = MockServer::start().await;
    mount_initial_sync_inbox_mocks(&server, false).await;

    let (storage, _directory) = temp_storage();
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(SyncEngineDeps {
        storage: storage.clone(),
        queue: queue,
        registry: registry,
        events: latentmail_lib::sync::noop_event_sink(),
    });
    let client = GmailClient::with_base_url("token", server.uri());

    engine.initial_sync("account", client).await.unwrap();

    assert!(
        wait_for_cursor_completed(&storage, 10_000).await.is_some(),
        "backfill enqueued by initial_sync never completed"
    );
}

#[tokio::test(start_paused = true)]
async fn backfill_advances_as_one_discrete_queue_operation_per_page() {
    let server = MockServer::start().await;
    mount_initial_sync_inbox_mocks(&server, true).await;

    let (storage, _directory) = temp_storage();
    let registry = WorkRegistry::new();
    let queue_events = Arc::new(Mutex::new(Vec::new()));
    let queue = latentmail_lib::sync::create_queue_engine_with_events(
        QueueRateConfig {
            rate_per_second: 250,
            burst: 250,
        },
        registry.clone(),
        queue_item_collector(Arc::clone(&queue_events)),
    );
    let engine = SyncEngine::new(SyncEngineDeps {
        storage: storage.clone(),
        queue: queue,
        registry: registry,
        events: latentmail_lib::sync::noop_event_sink(),
    });
    let client = GmailClient::with_base_url("token", server.uri());

    engine.initial_sync("account", client).await.unwrap();

    let cursor = wait_for_completed_and_ops(&storage, &queue_events, 2).await;
    assert!(matches!(&cursor, Some(cursor) if cursor.completed));

    let distinct_traversal_ops = completed_traversal_op_ids(&queue_events);
    assert_eq!(
        distinct_traversal_ops.len(),
        2,
        "a two-page backfill must complete as two separately queued traversal \
         operations, not one operation looping internally over both pages: {distinct_traversal_ops:?}"
    );
}

#[tokio::test]
async fn a_newer_traversal_snapshot_removes_labels_the_message_lost_upstream() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(message_json(MessageJson {
                id: "m1",
                thread_id: "t1",
                history_id: "10",
                subject: "Hello",
            })),
        )
        .mount(&server)
        .await;
    let (storage, _directory) = temp_storage();
    let client = GmailClient::with_base_url("token", server.uri()).traversal_scoped();
    let ids = ["m1".to_owned()];
    latentmail_lib::sync::traversal::fetch_and_persist(FetchPersistRequest {
        storage: &storage,
        client: &client,
        account_id: "account",
        ids: &ids,
        cache: None,
    })
    .await
    .unwrap();

    server.reset().await;
    let mut newer = message_json(MessageJson {
        id: "m1",
        thread_id: "t1",
        history_id: "20",
        subject: "Hello",
    });
    newer["labelIds"] = serde_json::json!(["INBOX"]);
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(newer))
        .mount(&server)
        .await;
    latentmail_lib::sync::traversal::fetch_and_persist(FetchPersistRequest {
        storage: &storage,
        client: &client,
        account_id: "account",
        ids: &ids,
        cache: None,
    })
    .await
    .unwrap();

    let connection = storage.connection().unwrap();
    assert_eq!(
        MessageRepository::label_ids(&connection, "account", "m1").unwrap(),
        vec!["INBOX".to_owned()]
    );
}
