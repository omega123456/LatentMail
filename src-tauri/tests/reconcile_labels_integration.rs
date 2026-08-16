//! Reconciliation's real pipeline (`sync::reconcile::run`, driven the same
//! way production does — through `SyncEngine::run_sync`'s expired-history
//! branch — against a fake Gmail server), not a direct call to a storage
//! repository method. Plan Phase 5 AC3's flagship claim ("a starred, unread
//! message in Trash retains both after reconciliation, proving Spam/Trash
//! inclusion on the per-label enumerations") previously had no test that
//! actually exercised `reconcile::run` at all — every assertion below drives
//! the real pass end to end.
//!
//! Reconciliation never running concurrently with backfill is covered by
//! `traversal_cursor_integration.rs`'s
//! `backfill_cursor_survives_reconciliation_and_resumes_after_it_completes`
//! (the D3 entity-lock fix's own test) — not duplicated here.

use latentmail_lib::{
    gmail::GmailClient,
    storage::{
        Account, AccountRepository, HtmlPresence, LabelRepository, Message, MessageRepository,
        Storage, Thread, ThreadRepository,
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

/// Mounts the fixed non-message-listing scaffolding every test here shares:
/// an expired history checkpoint (forces the reconciliation branch), a
/// fresh profile checkpoint, and three system labels — `TRASH`, `STARRED`,
/// `UNREAD` — which is all the flagship scenario needs from `labels.list`.
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

/// The flagship AC (Phase 5 AC3) plus two structural claims, all proven
/// against the real pipeline in one pass:
///
/// 1. A starred, unread message that lives only in Trash retains both flags
///    after reconciliation — which is only possible if the per-label
///    enumerations that build its membership actually included Spam/Trash.
/// 2. Every one of those per-label listing requests carries
///    `includeSpamTrash=true` (asserted on the wiremock request itself, not
///    inferred from the outcome).
/// 3. A thread untouched by this pass (no membership delta) is never
///    recomputed — proven by seeding it with a cached summary that
///    disagrees with its message rows and confirming reconciliation leaves
///    that disagreement exactly as it was.
#[tokio::test]
async fn starred_unread_message_in_trash_survives_reconciliation_via_the_real_pipeline() {
    let server = MockServer::start().await;
    mount_reconciliation_scaffold(&server).await;

    // The whole-mailbox universe listing (no `labelIds`) — includes both
    // the message this test is really about and one already-known,
    // untouched message ("kept").
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
    // Every per-label membership listing this message's three labels drive
    // must carry `includeSpamTrash=true` — the exact query-param assertion
    // the plan-adherence audit called out as missing.
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
    // "kept" already exists locally with no labels — reconciliation's
    // universe includes it (so it survives) and it appears in none of the
    // three per-label listings above (so its membership diff is a no-op).
    // Its thread is deliberately seeded with a subject that disagrees with
    // the message row: if reconciliation ever recomputed it, this would be
    // overwritten back to the message's real subject.
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

/// The checkpoint half of D6/D13: a reconciliation pass that fails partway
/// through must never adopt the fresh `historyId` it read up front — the
/// account's checkpoint has to stay exactly where it was, so the next sync
/// attempt retries reconciliation rather than silently treating a partial
/// repair as complete.
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
    // The universe discovers "new-message" as new and must fetch it in
    // full — mocked to fail every time, so the whole pass errors out.
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

/// Plan-adherence audit item 6: a message present in every one of this
/// pass's three labels must contribute exactly 1 to the final
/// `discoveredCount`/`persistedCount`, never 3 — the reported count is the
/// distinct-message universe size, not a sum across every per-label
/// listing page.
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
    // The same one message appears in all three per-label listings — the
    // exact shape that used to inflate the reported count to 3.
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

/// Re-audit fix: the touched-thread comparison used to be order-sensitive —
/// `MessageRepository::label_ids`'s DB read comes back `ORDER BY label_id`
/// (alphabetical: `STARRED`, `TRASH`, `UNREAD`), while `memberships` is
/// built in Gmail's *listing* order (`mount_reconciliation_scaffold`'s
/// fixture lists `TRASH`, `STARRED`, `UNREAD`) — so a message present in
/// 2+ labels compared unequal on almost every pass even when its label
/// *set* never actually changed, triggering a no-op `overwrite_membership`
/// write and marking its thread "touched". Phase 5 AC7's own untouched
/// fixture (`starred_unread_message_in_trash_survives_reconciliation_via_the_real_pipeline`'s
/// "kept" message) never caught this because it carries zero labels, where
/// both sides are trivially equal regardless of ordering.
///
/// This fixture seeds a message with all three of the scaffold's labels
/// already correctly assigned — the exact set the per-label listings below
/// report back, just in a different order — and proves its thread is never
/// recomputed.
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
    // The scaffold's labels list in `TRASH`, `STARRED`, `UNREAD` order — not
    // the DB's alphabetical read order — and every one of them reports this
    // message as a member.
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
    // Already carries exactly the label set the per-label listings above
    // will (re)report — nothing about its membership is actually changing,
    // only the order it's discovered in this pass.
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

/// A locally-known message that reconciliation discovers carries `SENT`
/// observes its `to`/`cc` recipients as contacts, exactly like the
/// mutation-driven contact-observation path — proving reconciliation's own
/// commit transaction (not just live sync) keeps the contacts table current
/// for messages the user sent.
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
