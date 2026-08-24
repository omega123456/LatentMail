use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use latentmail_lib::auth::AuthService;
use latentmail_lib::gmail::GmailClient;
use latentmail_lib::queue::{Executor, Lane, OperationKind, QueueEngine, QueueOperation};
use latentmail_lib::storage::{
    Account, AccountRepository, ComposeDraftMetadata, ComposeDraftMetadataRepository, HtmlPresence,
    Label, LabelRepository, Message, MessageRepository, Operation, OperationRepository, Storage,
    ThreadRepository, TraversalCursor, TraversalCursorRepository, TraversalKind,
};
use latentmail_lib::sync::{
    create_queue_engine_with_events, noop_event_sink, SyncEngine, WorkRegistry,
};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

fn seed_message(account_id: &str, id: &str, thread_id: &str) -> Message {
    Message {
        account_id: account_id.into(),
        id: id.into(),
        thread_id: thread_id.into(),
        rfc_message_id: None,
        sender: format!("{id}@example.com"),
        recipients: "me@example.com".into(),
        subject: "Hello".into(),
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

fn seed_account(connection: &rusqlite::Connection, account_id: &str) {
    AccountRepository::upsert(
        connection,
        &Account {
            id: account_id.into(),
            email: format!("{account_id}@example.com"),
            display_name: String::new(),
            avatar_url: None,
            history_id: Some(1),
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();

    for label_id in ["INBOX", "UNREAD"] {
        LabelRepository::upsert(
            connection,
            &Label {
                account_id: account_id.into(),
                id: label_id.into(),
                name: label_id.into(),
                kind: "system".into(),
                color: None,
                message_count: 0,
            },
        )
        .unwrap();
    }

    for n in 0..5 {
        let message_id = format!("{account_id}-message-{n}");
        let thread_id = format!("{account_id}-thread-{n}");
        MessageRepository::write_full_state(
            connection,
            &seed_message(account_id, &message_id, &thread_id),
        )
        .unwrap();
        MessageRepository::set_label_membership(connection, account_id, &message_id, "INBOX", true)
            .unwrap();
        MessageRepository::replace_inline_parts(
            connection,
            account_id,
            &message_id,
            &[latentmail_lib::storage::InlinePart {
                content_id: "cid".into(),
                mime_type: "image/png".into(),
                bytes: vec![1, 2, 3],
            }],
        )
        .unwrap();
        ThreadRepository::recompute(connection, account_id, &thread_id).unwrap();
    }

    TraversalCursorRepository::upsert(
        connection,
        &TraversalCursor {
            account_id: account_id.into(),
            kind: TraversalKind::Backfill,
            position: Some("cursor".into()),
            discovered_count: 5,
            persisted_count: 5,
            completed: false,
            last_advanced_at: 1,
            resumed: false,
        },
    )
    .unwrap();

    ComposeDraftMetadataRepository::upsert(
        connection,
        &ComposeDraftMetadata {
            account_id: account_id.into(),
            draft_id: "draft-1".into(),
            mode: "new".into(),
            original_message_id: None,
            original_gmail_message_id: None,
            target_thread_id: None,
            in_reply_to: None,
            rfc_references: None,
            boundary_version: 1,
            editable_body_fingerprint: None,
            quote_html: None,
            quote_plain: None,
        },
    )
    .unwrap();

    OperationRepository::upsert(
        connection,
        &Operation {
            id: format!("{account_id}-op-1"),
            account_id: account_id.into(),
            lane: "background".into(),
            kind: "sync".into(),
            entity_key: format!("sync:{account_id}"),
            payload: "{}".into(),
            status: "queued".into(),
            attempts: 0,
            next_attempt_at: None,
            error: None,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();

    connection
        .execute(
            "INSERT INTO contacts (account_id,address,display_name,frequency,last_seen_at) VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![account_id, format!("{account_id}@contact.example.com"), "Someone", 1, 1],
        )
        .unwrap();
}

fn count(connection: &rusqlite::Connection, sql: &str, account_id: &str) -> i64 {
    connection
        .query_row(sql, [account_id], |row| row.get(0))
        .unwrap()
}

fn message_search_row_count_for_seqs(connection: &rusqlite::Connection, seqs: &[i64]) -> i64 {
    if seqs.is_empty() {
        return 0;
    }
    let placeholders = seqs.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!("SELECT COUNT(*) FROM message_search WHERE rowid IN ({placeholders})");
    let params = rusqlite::params_from_iter(seqs.iter());
    connection
        .query_row(&sql, params, |row| row.get(0))
        .unwrap()
}

fn message_seqs_for_account(connection: &rusqlite::Connection, account_id: &str) -> Vec<i64> {
    connection
        .prepare("SELECT seq FROM messages WHERE account_id=?1")
        .unwrap()
        .query_map([account_id], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn all_rows_for_account_gone(
    connection: &rusqlite::Connection,
    account_id: &str,
    removed_message_seqs: &[i64],
) {
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM accounts WHERE id=?1",
            account_id
        ),
        0
    );
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM labels WHERE account_id=?1",
            account_id
        ),
        0
    );
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM messages WHERE account_id=?1",
            account_id
        ),
        0
    );
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM threads WHERE account_id=?1",
            account_id
        ),
        0
    );
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM operations WHERE account_id=?1",
            account_id
        ),
        0
    );
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM traversal_cursors WHERE account_id=?1",
            account_id
        ),
        0
    );
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM contacts WHERE account_id=?1",
            account_id
        ),
        0
    );
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM compose_draft_metadata WHERE account_id=?1",
            account_id
        ),
        0
    );
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM message_labels WHERE account_id=?1",
            account_id
        ),
        0
    );
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM message_inline_parts WHERE account_id=?1",
            account_id
        ),
        0
    );
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM thread_labels WHERE account_id=?1",
            account_id
        ),
        0
    );
    assert_eq!(
        message_search_row_count_for_seqs(connection, removed_message_seqs),
        0,
        "message_search must have no row for any of the removed account's former messages"
    );
}

#[tokio::test]
async fn removing_an_account_clears_every_direct_and_indirect_dependent_table() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    {
        let connection = storage.connection().unwrap();
        seed_account(&connection, "removed");
        seed_account(&connection, "kept");
    }

    latentmail_lib::auth::save_refresh_token("removed", "removed-refresh-token").unwrap();
    latentmail_lib::auth::save_refresh_token("kept", "kept-refresh-token").unwrap();

    let removed_message_seqs = {
        let connection = storage.connection().unwrap();
        message_seqs_for_account(&connection, "removed")
    };
    assert_eq!(
        removed_message_seqs.len(),
        5,
        "the fixture seeds five messages per account"
    );
    assert_eq!(
        message_search_row_count_for_seqs(&storage.connection().unwrap(), &removed_message_seqs),
        5,
        "every seeded message must be indexed by message_search before removal"
    );

    let auth = AuthService::new(storage.clone());
    let queue = QueueEngine::no_op();

    auth.remove_account(&queue, "removed").await.unwrap();

    let connection = storage.connection().unwrap();
    all_rows_for_account_gone(&connection, "removed", &removed_message_seqs);

    assert_eq!(
        count(
            &connection,
            "SELECT COUNT(*) FROM accounts WHERE id=?1",
            "kept"
        ),
        1
    );
    assert_eq!(
        count(
            &connection,
            "SELECT COUNT(*) FROM messages WHERE account_id=?1",
            "kept"
        ),
        5
    );
    assert_eq!(
        count(
            &connection,
            "SELECT COUNT(*) FROM thread_labels WHERE account_id=?1",
            "kept"
        ),
        5
    );

    let violations: i64 = connection
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query_map([], |_row| Ok(()))
        .unwrap()
        .count() as i64;
    assert_eq!(
        violations, 0,
        "PRAGMA foreign_key_check must report no violations"
    );

    assert!(!latentmail_lib::auth::has_refresh_token("removed"));
    assert!(latentmail_lib::auth::has_refresh_token("kept"));

    assert!(AccountRepository::get(&connection, "removed")
        .unwrap()
        .is_none());

    for (label, sql) in [
        (
            "message_labels",
            "EXPLAIN QUERY PLAN DELETE FROM message_labels WHERE account_id='removed' AND message_id='removed-message-0'",
        ),
        (
            "message_inline_parts",
            "EXPLAIN QUERY PLAN DELETE FROM message_inline_parts WHERE account_id='removed' AND message_id='removed-message-0'",
        ),
        (
            "thread_labels",
            "EXPLAIN QUERY PLAN DELETE FROM thread_labels WHERE account_id='removed' AND thread_id='removed-thread-0'",
        ),
    ] {
        let steps: Vec<String> = connection
            .prepare(sql)
            .unwrap()
            .query_map([], |row| row.get::<_, String>(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(
            !steps.iter().any(|step| step.contains("SCAN")),
            "cascade delete from {label} must use an index, not a full scan: {steps:?}"
        );
    }
}

#[tokio::test]
async fn removing_an_unknown_account_reports_an_error_and_leaves_nothing_to_clean_up() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth = AuthService::new(storage);
    let queue = QueueEngine::no_op();

    assert!(auth.remove_account(&queue, "missing").await.is_err());
}

fn controllable_executor() -> (
    Executor,
    mpsc::UnboundedReceiver<(String, oneshot::Sender<()>)>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    let executor: Executor = Arc::new(move |operation: QueueOperation| {
        let tx = tx.clone();
        Box::pin(async move {
            let (release_tx, release_rx) = oneshot::channel();
            let _ = tx.send((operation.id, release_tx));
            let _ = release_rx.await;
            Ok(())
        })
    });
    (executor, rx)
}

fn operation(id: &str, account_id: &str, entity_key: &str) -> QueueOperation {
    QueueOperation {
        id: id.into(),
        account_id: account_id.into(),
        lane: Lane::Background,
        kind: OperationKind::Sync,
        entity_key: entity_key.into(),
        cost: 0,
        attempts: 0,
        description: "Sync mailbox".into(),
    }
}

#[tokio::test]
async fn removing_an_account_with_pending_queued_work_cancels_it_and_no_operation_is_dispatched() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    {
        let connection = storage.connection().unwrap();
        seed_account(&connection, "removed");
    }
    latentmail_lib::auth::save_refresh_token("removed", "token").unwrap();

    let (executor, mut dispatched) = controllable_executor();
    let queue = QueueEngine::new(250, 250, executor);

    queue
        .enqueue(operation("held", "removed", "sync:removed"))
        .await
        .unwrap();
    let (id, release) = dispatched.recv().await.expect("first op dispatches");
    assert_eq!(id, "held");

    queue
        .enqueue(operation("parked", "removed", "sync:removed"))
        .await
        .unwrap();
    tokio::task::yield_now().await;
    assert!(
        dispatched.try_recv().is_err(),
        "the second operation must park behind the entity lock, not execute"
    );

    let auth = AuthService::new(storage.clone());
    auth.remove_account(&queue, "removed").await.unwrap();

    assert!(
        dispatched.try_recv().is_err(),
        "the cancelled operation must never reach the executor"
    );
    let _ = release.send(());

    let snapshot = queue.snapshot().await;
    let removed_account = snapshot
        .into_iter()
        .find(|account| account.account_id == "removed");
    let remaining_pending = removed_account
        .map(|account| {
            account
                .lanes
                .into_iter()
                .flat_map(|lane| lane.operations)
                .filter(|operation| {
                    matches!(
                        operation.status,
                        latentmail_lib::queue::OperationStatus::Queued
                            | latentmail_lib::queue::OperationStatus::Retrying
                    )
                })
                .count()
        })
        .unwrap_or(0);
    assert_eq!(
        remaining_pending, 0,
        "no queued work should remain for the removed account"
    );
}

#[tokio::test]
async fn removing_an_account_evicts_a_registry_backed_operations_closure_so_its_caller_never_hangs()
{
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    {
        let connection = storage.connection().unwrap();
        AccountRepository::upsert(
            &connection,
            &Account {
                id: "removed".into(),
                email: "removed@example.com".into(),
                display_name: String::new(),
                avatar_url: None,
                history_id: Some(1),
                needs_reauthentication: false,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
    }
    latentmail_lib::auth::save_refresh_token("removed", "token").unwrap();

    let registry = WorkRegistry::new();
    let queue =
        create_queue_engine_with_events(250, 250, Arc::clone(&registry), Arc::new(|_, _| {}));
    let engine = SyncEngine::new(
        storage.clone(),
        Arc::clone(&queue),
        registry,
        noop_event_sink(),
    );

    queue.pause();

    let mutate_engine = Arc::clone(&engine);
    let caller = tokio::spawn(async move {
        mutate_engine
            .mutate(
                "removed",
                GmailClient::with_base_url("token", "http://127.0.0.1:1".to_owned()),
                "thread-1".to_owned(),
                HashSet::from(["STARRED".to_owned()]),
                HashSet::new(),
            )
            .await
    });

    loop {
        let snapshot = queue.snapshot().await;
        let has_registered_operation = snapshot
            .iter()
            .find(|account| account.account_id == "removed")
            .is_some_and(|account| account.lanes.iter().any(|lane| !lane.operations.is_empty()));
        if has_registered_operation {
            break;
        }
        tokio::task::yield_now().await;
    }

    let auth = AuthService::new(storage.clone());
    auth.remove_account(&queue, "removed").await.unwrap();

    let result = timeout(Duration::from_secs(1), caller)
        .await
        .expect("the caller awaiting the evicted closure must resolve rather than hang")
        .expect("the awaiting task itself does not panic");
    assert!(
        result.is_err(),
        "the caller awaiting an operation whose closure was evicted on removal resolves with an error"
    );
}

#[tokio::test]
async fn removing_an_account_drains_the_semantic_index_through_an_embedding_barrier() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    AccountRepository::upsert(
        &storage.connection().unwrap(),
        &Account {
            id: "indexed".into(),
            email: "indexed@example.com".into(),
            display_name: String::new(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    latentmail_lib::auth::save_refresh_token("indexed", "token").unwrap();

    let registry = WorkRegistry::new();
    let queue = create_queue_engine_with_events(250, 250, Arc::clone(&registry), Arc::new(|_, _| {}));
    let engine = SyncEngine::new(
        storage.clone(),
        Arc::clone(&queue),
        registry,
        noop_event_sink(),
    );
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    tauri::Manager::manage(&app, AuthService::new(storage.clone()));
    tauri::Manager::manage(&app, queue);
    tauri::Manager::manage(&app, engine);
    tauri::Manager::manage(&app, latentmail_lib::ai::AiService::new(storage.clone()));

    timeout(
        Duration::from_secs(2),
        latentmail_lib::auth::remove_account(
            tauri::Manager::app_handle(&app).clone(),
            tauri::Manager::state(&app),
            tauri::Manager::state(&app),
            tauri::Manager::state(&app),
            "indexed".into(),
        ),
    )
    .await
    .expect("the embedding barrier resolves rather than hanging")
    .unwrap();

    assert!(AccountRepository::list(&storage.connection().unwrap())
        .unwrap()
        .is_empty());
}
