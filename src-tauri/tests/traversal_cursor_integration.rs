//! Whole-mailbox backfill (`sync::traversal::run_backfill_step`, driven one
//! discrete page at a time — the real production path is
//! `SyncEngine::enqueue_backfill`/`enqueue_backfill_step` in `sync::mod`):
//! enumeration shape (no label filter, no date bound, Spam/Trash included,
//! explicit page size), what gets persisted
//! (metadata/memberships/truncated body, never full HTML or inline parts),
//! checkpoint-only-on-batch-completion resumability, and completion
//! detection.
//!
//! Every test here drives backfill through a real production entry point:
//! `run_backfill_step` directly for tests that only need single-page
//! behaviour (`run_backfill_step` *is* the discrete unit of work
//! `enqueue_backfill_step` enqueues one of per call — there is no separate
//! "whole run" wrapper in production to call instead), and
//! `SyncEngine::initial_sync`/`run_sync` (the real queued path) for tests
//! whose whole point is multi-page/queue behaviour such as pause/resume.

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

/// Every table traversal touches (`messages`, `traversal_cursors`, ...)
/// foreign-keys against `accounts`, so every test needs one on the books
/// first — mirroring `sync_initial_integration.rs`'s own test fixture.
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
        ], "body": { "data": "aGVsbG8td29ybGQ" } } // "hello-world"
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

/// Drives backfill through the real production path — `SyncEngine`, a real
/// `QueueEngine`, and `initial_sync`'s own trigger of `enqueue_backfill` —
/// rather than the old whole-run `run_backfill` wrapper (deleted as dead
/// code: production has called only the per-page `enqueue_backfill_step`
/// chain since backfill became one discrete queue operation per page).
/// Pausing is now the queue's own admission gate
/// (`QueueEngine::run`'s `wait_until_resumed`, evaluated fresh for every
/// per-page operation) rather than a manual check `run_backfill` used to
/// make between pages — this proves that real gate still halts a resumable
/// traversal at a batch boundary and lets it continue once resumed.
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
    // Initial sync's own Inbox-scoped, 30-day-bound listing (`full_sync_body`)
    // — empty, so it completes immediately and backfill is enqueued right
    // after. Distinguished from backfill's own listing below by the `q`
    // param, which only initial sync's request carries.
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("q", "newer_than:30d"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})),
        )
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
    // Pauses the instant backfill reports its first page's progress — i.e.
    // right after page 1's batch has committed — so the next page's
    // separately-queued operation is left blocked in the queue's own
    // admission gate.
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
    // Re-audit fix: a fresh, uninterrupted run must never read as "resumed"
    // just because page 1 committed a non-null `position` — that used to
    // make the status bar show "Resuming backfill" from page 2 onward on
    // every ordinary run.
    assert!(
        !cursor.resumed,
        "page 2 of a fresh, uninterrupted run must not read as resumed"
    );

    // Give the (blocked) second page every reasonable chance to run before
    // asserting it hasn't — bounded and sleep-free, per this repo's testing
    // conventions.
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

/// Re-audit fix, the other half: a run that genuinely does pick up a
/// checkpoint a *previous* process/run left behind must read as "resumed"
/// on every page of that run — not just its first — proving the flag,
/// once snapshotted at run start (`SyncEngine::enqueue_backfill`), is
/// carried forward unchanged rather than re-derived from `position` (which
/// would make it look resumed forever, `active_backfill_pauses_...`'s
/// fresh-run case) or reset partway through (which this test guards
/// against).
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
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})),
        )
        .mount(&server)
        .await;
    // Two remaining pages of the leftover run below — "page2" (this run's
    // first step) advances to "page3" (its second), which then completes.
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
    // A checkpoint left by a previous, interrupted process's run — exactly
    // what `SyncEngine::enqueue_backfill` reads to decide this new run is a
    // resumption. `resumed: false` here on purpose: this is what the row
    // looked like mid-run, *before* this fix existed to persist the flag at
    // all.
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
    let sink: EventSink = Arc::new(move |name, _payload| {
        if name == "sync://traversal" {
            pause_queue.pause();
        }
    });
    let engine = SyncEngine::new(storage.clone(), queue.clone(), registry, sink);
    let client = GmailClient::with_base_url("token", server.uri());
    engine.initial_sync("account", client).await.unwrap();

    // This run's page 1 (resuming from the leftover "page2" checkpoint) —
    // wait for it to commit and pause the next page.
    let mut cursor = None;
    for _ in 0..1_000 {
        cursor = storage
            .run(|connection| {
                TraversalCursorRepository::get(connection, "account", TraversalKind::Backfill)
            })
            .await
            .unwrap();
        if matches!(cursor, Some(ref cursor) if cursor.position.as_deref() == Some("page3")) {
            break;
        }
        tokio::task::yield_now().await;
    }
    let cursor = cursor.expect("this run's first page must have committed");
    assert_eq!(cursor.position.as_deref(), Some("page3"));
    assert!(
        cursor.resumed,
        "page 1 of a resumed run must read as resumed"
    );

    queue.resume();

    // This run's page 2 (the final one) — must still read as resumed.
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
        tokio::task::yield_now().await;
    }
    let final_cursor = final_cursor.expect("backfill must complete");
    assert!(
        final_cursor.resumed,
        "page 2+ of the same resumed run must still read as resumed, not flip back"
    );
}

/// AC1: enumeration carries no label filter and no date bound (`q`), sets
/// `includeSpamTrash=true` and an explicit `maxResults`.
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
    // A single unpaginated page — one call to the real discrete unit of
    // work is the whole run.
    run_backfill_step(
        &storage,
        &client.traversal_scoped(),
        "account",
        &latentmail_lib::sync::noop_event_sink(),
        false,
    )
    .await
    .unwrap();

    server.verify().await;
}

/// AC2: a persisted message carries metadata, label membership and a
/// truncated body — but never a full HTML/plain body, and
/// `html_presence` stays `never_fetched` so opening it later triggers a
/// lazy fetch (Phase 6).
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

/// AC3 + AC4: interrupting between pages leaves the cursor at the last
/// *completed* batch (not advancing for the failed one), and restarting
/// resumes from there — re-fetching neither the earlier page's listing nor
/// its already-persisted message.
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
    // The very first attempt fails while fetching page 2's message — the
    // page-1 batch must already have committed by this point. 403 (not
    // 500/429) so the Gmail client's own internal retry-with-backoff never
    // masks it by quietly succeeding against the fallback mock below.
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

    // Page 1: the real per-page unit of work, run directly — this is
    // exactly what `enqueue_backfill_step`'s registered closure calls in
    // production for the first queued operation.
    let page_one = run_backfill_step(
        &storage,
        &client,
        "account",
        &latentmail_lib::sync::noop_event_sink(),
        false,
    )
    .await;
    assert!(page_one.is_ok(), "page 1 must commit cleanly");
    assert!(!page_one.unwrap(), "page 1 alone is not the whole backfill");

    // Page 2: mocked to fail its message fetch — the production analogue of
    // this operation's own queued step erroring out.
    let page_two = run_backfill_step(
        &storage,
        &client,
        "account",
        &latentmail_lib::sync::noop_event_sink(),
        false,
    )
    .await;
    assert!(
        page_two.is_err(),
        "page 2's message fetch was mocked to fail"
    );

    // AC4: the cursor reflects only the completed page-1 batch — position
    // is page 2's token (the *next* thing to do), not page 2 itself.
    let connection = storage.connection().unwrap();
    let cursor = TraversalCursorRepository::get(&connection, "account", TraversalKind::Backfill)
        .unwrap()
        .unwrap();
    assert_eq!(cursor.position.as_deref(), Some("page2"));
    assert_eq!(cursor.discovered_count, 2);
    assert_eq!(cursor.persisted_count, 1);
    assert!(!cursor.completed);
    drop(connection);

    // Resuming (a fresh call to the same discrete unit, exactly as the
    // queue's re-enqueued next operation would do) must not re-list page 1
    // (`.expect(1)` above) or re-fetch m1 (`.expect(1)` above) — both would
    // panic on verification if hit again.
    let second_attempt = run_backfill_step(
        &storage,
        &client,
        "account",
        &latentmail_lib::sync::noop_event_sink(),
        false,
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

/// Scheduler-tick dedupe: `SyncEngine::enqueue_backfill` is called
/// unconditionally on every scheduler tick (`start_scheduler`), and a fresh
/// backfill routinely outlives one `sync_interval_minutes` window. A second
/// call while a chain is already live for the account must be a no-op — not
/// a second, interleaved chain racing the first — and the guard must not
/// wedge future backfills once the in-flight chain actually finishes.
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
    // Initial sync's own Inbox-scoped listing — empty, so it completes
    // immediately and the first backfill chain is enqueued right after.
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("q", "newer_than:30d"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})),
        )
        .mount(&server)
        .await;
    // Backfill's own two-page enumeration. `.expect(1)` on each page is
    // exactly what would trip if a bogus second chain re-listed a page the
    // first chain already owns.
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
    // A dedicated queue-event collector (as in
    // `backfill_advances_as_one_discrete_queue_operation_per_page`) — lets
    // this test count discrete traversal `QueueOperation`s directly, rather
    // than inferring chain count from cursor state alone.
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
    // Pauses the instant backfill's first page commits, leaving page 2's
    // separately-queued operation blocked in the queue's own admission
    // gate — i.e. the first chain is genuinely still "in flight" (not yet
    // terminal) for the rest of this test until `queue.resume()`.
    let sink: EventSink = Arc::new(move |name, _payload| {
        if name == "sync://traversal" {
            pause_queue.pause();
        }
    });
    let engine = SyncEngine::new(storage.clone(), queue.clone(), registry, sink);
    let client = GmailClient::with_base_url("token", server.uri());

    engine.initial_sync("account", client.clone()).await.unwrap();

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

    // Wait for the chain's first page to commit — the chain is now
    // in-flight (page 2 queued but blocked on the paused admission gate).
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
        cursor.expect("page 1 must have committed and its operation must settle").position.as_deref(),
        Some("page2")
    );
    assert_eq!(distinct_traversal_ops(), 1, "only page 1 has completed so far");

    // Simulate a second scheduler tick firing mid-run — exactly the
    // production bug this test guards against.
    engine.enqueue_backfill("account", client.clone()).await;

    // Give a bogus second chain every reasonable chance to start before
    // asserting it hasn't — bounded and sleep-free per this repo's testing
    // conventions.
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        distinct_traversal_ops(),
        1,
        "a second enqueue_backfill call while the first chain is in-flight must not start a new chain"
    );

    // Let the first chain finish.
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
    assert!(completed, "the first (only) chain must complete");
    assert_eq!(
        distinct_traversal_ops(),
        2,
        "the completed chain must be exactly the original two pages — no interleaved third op"
    );
    server.verify().await;

    // The guard must not wedge future backfills: once the in-flight chain
    // is genuinely terminal, a later `enqueue_backfill` call must start
    // normally again (proven by a third traversal queue operation actually
    // running, rather than being silently skipped by a guard that never
    // cleared). Page 2 fires its own `sync://traversal` progress event on
    // its way to completing (same as page 1), which re-triggers this
    // test's pause sink — resume once more so the fresh chain's own
    // operation isn't blocked by that unrelated admission gate.
    queue.resume();
    engine.enqueue_backfill("account", client).await;
    let mut saw_third_op = false;
    for _ in 0..1_000 {
        if distinct_traversal_ops() == 3 {
            saw_third_op = true;
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        saw_third_op,
        "enqueue_backfill must start normally again once the prior chain is terminal"
    );
}

/// D3 fix (migration `V4__traversal_cursor_composite_key`): backfill and
/// reconciliation cursors are keyed by `(account_id, kind)`, so an existing
/// reconciliation-kind row for the account is simply invisible to
/// `run_backfill_step` — it reads and writes only its own `Backfill`-kind
/// row, runs to completion normally, and never touches the reconciliation
/// row.
/// Real mutual exclusion between the two traversals is the queue's
/// per-account entity lock (`traversal_entity_key`, D3), not this table —
/// this test only proves the storage layer no longer confuses the two.
/// Before this fix, this exact setup made every backfill call a silent,
/// permanent no-op (the bug this migration/test guards against).
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
    // A single unpaginated page.
    run_backfill_step(
        &storage,
        &client,
        "account",
        &latentmail_lib::sync::noop_event_sink(),
        false,
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

/// D3 fix, end to end: seeding an in-progress backfill cursor and then
/// running a full reconciliation pass (via `SyncEngine`'s expired-history
/// path, the real production trigger) must leave the backfill cursor's
/// position/counts completely untouched, and a subsequent `run_backfill`
/// call must resume from exactly that position and complete — not silently
/// no-op forever, which was this bug's actual production symptom.
#[tokio::test]
async fn backfill_cursor_survives_reconciliation_and_resumes_after_it_completes() {
    let server = MockServer::start().await;
    // Forces `SyncEngine::incremental_sync` down the reconciliation branch.
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
    // Reconciliation's own whole-mailbox universe/membership enumeration —
    // no `pageToken` on this request, distinguishing it from backfill's
    // resumed page-2 request mocked below.
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param_is_missing("pageToken"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})),
        )
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

    // An in-progress backfill, paused mid-run at page 2.
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

    // The backfill cursor must be exactly as it was before reconciliation
    // ran — this is the core of the fix: reconciliation's own checkpoint
    // writes go to its own row and never touch backfill's.
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

    // Now resume backfill from page 2 and let it finish.
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
    // A single remaining page — resuming the preserved `page2` position.
    run_backfill_step(
        &storage,
        &client,
        "account",
        &latentmail_lib::sync::noop_event_sink(),
        true,
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

/// The shared fetch path Phase 5's reconciliation also calls (standalone
/// from `run_backfill`'s own per-page batching, and with no cursor
/// involvement of its own): fetches and persists a set of identifiers,
/// returning the distinct thread ids touched.
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
    // No cursor bookkeeping is this function's concern — reconciliation
    // owns its own checkpoint, independent of backfill's.
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

/// AC9: a cursor already marked complete stops backfill from restarting —
/// no Gmail request is made at all.
#[tokio::test]
async fn a_completed_cursor_is_not_restarted() {
    let server = MockServer::start().await; // nothing mounted — any request 404s
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
    )
    .await
    .unwrap();
}

/// AC10 (D11): progress events carry counts only — no percentage or
/// estimate field ever appears in the payload.
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
    run_backfill_step(&storage, &client, "account", &sink, false)
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

/// End-to-end wiring (Phase 4 scope: "wire traversal into initialization
/// and scheduling"): `SyncEngine::initial_sync` enqueues backfill as a
/// traversal-lane operation once it completes, without changing initial
/// sync's own behaviour — the same fixture `sync_initial_integration.rs`
/// uses answers every request backfill's whole-mailbox enumeration makes
/// too, since it revisits the same one page of messages.
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

    // Backfill runs as a separate, asynchronously dispatched queue
    // operation on a background task — under paused mock time, yield
    // repeatedly (rather than sleeping any real or virtual duration) so
    // that task gets scheduled without this test depending on wall-clock
    // timing at all.
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

/// Plan-adherence audit item 5: backfill must proceed as discrete,
/// separately-queued units of work — one traversal-lane `QueueOperation`
/// per page — rather than one operation that internally loops over the
/// whole multi-page backfill. Before this fix, a two-page backfill produced
/// exactly one `queue://item` "done" event; after it, it must produce one
/// per page, each under its own operation id, proving the traversal lane
/// permit and the account's entity lock are genuinely released and
/// re-acquired between pages rather than held for the run's whole duration.
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
            .respond_with(
                ResponseTemplate::new(200).set_body_json(message_json(id, id, "10", id)),
            )
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
    // A dedicated *queue*-event collector (distinct from the sync/traversal
    // `EventSink` every other test in this file uses) — this is what lets
    // this test count discrete `QueueOperation`s, not persisted progress.
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
    assert!(matches!(&cursor, Some(cursor) if cursor.completed));

    let distinct_traversal_ops: std::collections::HashSet<String> = queue_events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event["status"] == "done")
        .filter_map(|event| event["id"].as_str())
        .filter(|id| id.starts_with("traversal:account:"))
        .map(str::to_owned)
        .collect();
    assert_eq!(
        distinct_traversal_ops.len(),
        2,
        "a two-page backfill must complete as two separately queued traversal \
         operations, not one operation looping internally over both pages: {distinct_traversal_ops:?}"
    );
}
