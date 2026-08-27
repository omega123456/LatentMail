use latentmail_lib::storage::{
    truncate_body, Account, AccountRepository, Attachment, AttachmentRepository,
    ComposeDraftMetadata, ComposeDraftMetadataRepository, EmbeddingRepository, HtmlPresence, Label,
    LabelColor, LabelNameError, LabelRepository, Message, MessageRepository, Operation,
    OperationRepository, RetrievalRepository, SettingRepository, Storage, Thread, ThreadIdentity,
    ThreadRepository, TraversalCursor, TraversalCursorRepository, TraversalKind,
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
fn message() -> Message {
    Message {
        account_id: "account".into(),
        id: "message".into(),
        thread_id: "thread".into(),
        rfc_message_id: Some("<message>".into()),
        sender: "sender@example.com".into(),
        recipients: "recipient@example.com".into(),
        subject: "Subject".into(),
        sent_at: 1,
        snippet: "Snippet".into(),
        html_body: Some("<p>HTML</p>".into()),
        plain_body: Some("Plain".into()),
        has_attachments: true,
        is_unread: false,
        is_starred: false,
        history_id: 1,
        truncated_body: None,
        html_presence: HtmlPresence::Absent,
    }
}

fn query_plan(connection: &rusqlite::Connection, sql: &str) -> Vec<String> {
    let mut statement = connection.prepare(sql).unwrap();
    let placeholders = vec![rusqlite::types::Value::Null; statement.parameter_count()];
    statement
        .query_map(rusqlite::params_from_iter(placeholders), |row| row.get(3))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn table_columns(connection: &rusqlite::Connection, table: &str) -> Vec<(String, bool, i64)> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap();
    statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(3)? == 1,
                row.get::<_, i64>(5)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn unique_indexed_column_sets(connection: &rusqlite::Connection, table: &str) -> Vec<Vec<String>> {
    let mut index_statement = connection
        .prepare(&format!("PRAGMA index_list({table})"))
        .unwrap();
    let indexes: Vec<(String, bool)> = index_statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(2)? == 1))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    indexes
        .into_iter()
        .filter(|(_, unique)| *unique)
        .map(|(name, _)| {
            let mut column_statement = connection
                .prepare(&format!("PRAGMA index_info({name})"))
                .unwrap();
            column_statement
                .query_map([], |row| row.get::<_, String>(2))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        })
        .collect()
}

#[test]
fn migrations_are_idempotent_and_repositories_round_trip() {
    let mut connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    assert_eq!(
        AccountRepository::get(&connection, "account").unwrap(),
        Some(account())
    );
    assert_eq!(
        AccountRepository::list(&connection).unwrap(),
        vec![account()]
    );
    let unread = Label {
        account_id: "account".into(),
        id: "UNREAD".into(),
        name: "Unread".into(),
        kind: "system".into(),
        color: None,
        message_count: 1,
    };
    let starred = Label {
        id: "STARRED".into(),
        name: "Starred".into(),
        ..unread.clone()
    };
    LabelRepository::upsert(&connection, &unread).unwrap();
    LabelRepository::upsert(&connection, &starred).unwrap();
    assert_eq!(
        LabelRepository::list(&connection, "account").unwrap(),
        vec![starred, unread]
    );
    assert!(MessageRepository::write_full_state(&connection, &message()).unwrap());
    MessageRepository::set_recipient_roles(
        &connection,
        "account",
        "message",
        "to@example.com",
        "cc@example.com",
        "bcc@example.com",
        Some("<first> <second>"),
    )
    .unwrap();
    assert_eq!(
        MessageRepository::recipient_roles(&connection, "account", "message").unwrap(),
        (
            "to@example.com".into(),
            "cc@example.com".into(),
            "bcc@example.com".into()
        )
    );
    let metadata = ComposeDraftMetadata {
        account_id: "account".into(),
        draft_id: "draft".into(),
        mode: "reply".into(),
        original_message_id: Some("message".into()),
        original_gmail_message_id: None,
        target_thread_id: Some("thread".into()),
        in_reply_to: Some("<message>".into()),
        rfc_references: Some("<message>".into()),
        boundary_version: 1,
        editable_body_fingerprint: None,
        quote_html: Some("<blockquote>quote</blockquote>".into()),
        quote_plain: Some("quote".into()),
    };
    ComposeDraftMetadataRepository::upsert(&connection, &metadata).unwrap();
    assert_eq!(
        ComposeDraftMetadataRepository::get(&connection, "account", "draft").unwrap(),
        Some(metadata)
    );
    ComposeDraftMetadataRepository::remove(&connection, "account", "draft").unwrap();
    MessageRepository::set_label_membership(&connection, "account", "message", "UNREAD", true)
        .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "message", "STARRED", true)
        .unwrap();
    assert!(
        MessageRepository::get(&connection, "account", "message")
            .unwrap()
            .unwrap()
            .is_unread
    );
    MessageRepository::set_label_membership(&connection, "account", "message", "UNREAD", false)
        .unwrap();
    assert!(
        !MessageRepository::get(&connection, "account", "message")
            .unwrap()
            .unwrap()
            .is_unread
    );
    let thread = Thread {
        account_id: "account".into(),
        id: "thread".into(),
        subject: "Subject".into(),
        participants: "sender@example.com".into(),
        latest_at: 1,
        message_count: 1,
        is_unread: false,
        is_starred: true,
        has_attachments: true,
        has_draft: false,
        sender_identity: ThreadIdentity {
            display: "sender@example.com".into(),
            address: Some("sender@example.com".into()),
        },
        recipient_identity: None,
    };
    ThreadRepository::upsert(&connection, &thread).unwrap();
    assert_eq!(
        ThreadRepository::get(&connection, "account", "thread").unwrap(),
        Some(thread)
    );
    SettingRepository::set(&connection, "theme", "dark").unwrap();
    assert_eq!(
        SettingRepository::get(&connection, "theme")
            .unwrap()
            .as_deref(),
        Some("dark")
    );
    let operation = Operation {
        id: "operation".into(),
        account_id: "account".into(),
        lane: "interactive".into(),
        kind: "send".into(),
        entity_key: "message".into(),
        payload: "{}".into(),
        status: "queued".into(),
        attempts: 0,
        next_attempt_at: None,
        error: None,
        created_at: 1,
        updated_at: 1,
    };
    OperationRepository::upsert(&connection, &operation).unwrap();
    assert_eq!(
        OperationRepository::get(&connection, "operation").unwrap(),
        Some(operation)
    );
    refinery::embed_migrations!("./migrations");
    migrations::runner().run(&mut connection).unwrap();
}

#[test]
fn html_presence_carries_three_distinguishable_states() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    let mut backfilled = message();
    backfilled.id = "backfilled".into();
    backfilled.html_body = None;
    backfilled.html_presence = HtmlPresence::NeverFetched;
    MessageRepository::write_full_state(&connection, &backfilled).unwrap();
    assert_eq!(
        MessageRepository::get(&connection, "account", "backfilled")
            .unwrap()
            .unwrap()
            .html_presence,
        HtmlPresence::NeverFetched
    );

    MessageRepository::set_body(
        &connection,
        "account",
        "backfilled",
        None,
        Some("hi"),
        HtmlPresence::Absent,
    )
    .unwrap();
    let absent = MessageRepository::get(&connection, "account", "backfilled")
        .unwrap()
        .unwrap();
    assert_eq!(absent.html_presence, HtmlPresence::Absent);
    assert!(absent.html_body.is_none());

    MessageRepository::set_body(
        &connection,
        "account",
        "backfilled",
        Some("<p>hi</p>"),
        None,
        HtmlPresence::Present,
    )
    .unwrap();
    let present = MessageRepository::get(&connection, "account", "backfilled")
        .unwrap()
        .unwrap();
    assert_eq!(present.html_presence, HtmlPresence::Present);
    assert_eq!(present.html_body.as_deref(), Some("<p>hi</p>"));
}

#[test]
fn truncated_body_caps_at_ten_thousand_chars_and_prefers_plain_text() {
    let long_plain = "a".repeat(12_000);
    let truncated = truncate_body(Some(&long_plain), None).unwrap();
    assert_eq!(truncated.chars().count(), 10_000);
    assert!(truncated.chars().all(|c| c == 'a'));

    let with_both = truncate_body(Some("plain wins"), Some("<p>html loses</p>")).unwrap();
    assert_eq!(with_both, "plain wins");

    let html_only = truncate_body(None, Some("<p>Hello <b>world</b></p>")).unwrap();
    assert_eq!(html_only, "Hello world");

    assert_eq!(truncate_body(None, None), None);
}

#[test]
fn traversal_cursor_round_trips_and_survives_reopening() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mail.sqlite");
    {
        let storage = Storage::open(&path).unwrap();
        let connection = storage.connection().unwrap();
        AccountRepository::upsert(&connection, &account()).unwrap();
        TraversalCursorRepository::upsert(
            &connection,
            &TraversalCursor {
                account_id: "account".into(),
                kind: TraversalKind::Backfill,
                position: Some("page-token-3".into()),
                discovered_count: 500,
                persisted_count: 420,
                completed: false,
                last_advanced_at: 1_700_000_000,
                resumed: true,
            },
        )
        .unwrap();
    }
    let storage = Storage::open(&path).unwrap();
    let connection = storage.connection().unwrap();
    let cursor = TraversalCursorRepository::get(&connection, "account", TraversalKind::Backfill)
        .unwrap()
        .unwrap();
    assert_eq!(cursor.kind, TraversalKind::Backfill);
    assert_eq!(cursor.position.as_deref(), Some("page-token-3"));
    assert_eq!(cursor.discovered_count, 500);
    assert_eq!(cursor.persisted_count, 420);
    assert!(!cursor.completed);
    assert!(cursor.resumed, "the resumed flag must round-trip too");

    TraversalCursorRepository::upsert(
        &connection,
        &TraversalCursor {
            completed: true,
            position: Some("page-token-4".into()),
            ..cursor.clone()
        },
    )
    .unwrap();
    let updated = TraversalCursorRepository::get(&connection, "account", TraversalKind::Backfill)
        .unwrap()
        .unwrap();
    assert!(updated.completed);
    assert_eq!(updated.position.as_deref(), Some("page-token-4"));

    TraversalCursorRepository::upsert(
        &connection,
        &TraversalCursor {
            account_id: "account".into(),
            kind: TraversalKind::Reconciliation,
            position: Some("universe".into()),
            discovered_count: 10,
            persisted_count: 10,
            completed: false,
            last_advanced_at: 1_700_000_001,
            resumed: false,
        },
    )
    .unwrap();
    let backfill_after_reconciliation_write =
        TraversalCursorRepository::get(&connection, "account", TraversalKind::Backfill)
            .unwrap()
            .unwrap();
    assert_eq!(
        backfill_after_reconciliation_write, updated,
        "writing a reconciliation cursor must not touch the backfill cursor's row"
    );
    let reconciliation =
        TraversalCursorRepository::get(&connection, "account", TraversalKind::Reconciliation)
            .unwrap()
            .unwrap();
    assert_eq!(reconciliation.position.as_deref(), Some("universe"));
    assert_eq!(reconciliation.discovered_count, 10);

    TraversalCursorRepository::delete(&connection, "account", TraversalKind::Backfill).unwrap();
    assert!(
        TraversalCursorRepository::get(&connection, "account", TraversalKind::Backfill)
            .unwrap()
            .is_none()
    );
    assert!(
        TraversalCursorRepository::get(&connection, "account", TraversalKind::Reconciliation)
            .unwrap()
            .is_some()
    );

    TraversalCursorRepository::delete(&connection, "account", TraversalKind::Reconciliation)
        .unwrap();
    assert!(
        TraversalCursorRepository::get(&connection, "account", TraversalKind::Reconciliation)
            .unwrap()
            .is_none()
    );
}

#[test]
fn bulk_membership_overwrite_keeps_denormalised_flags_consistent() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    for label_id in ["UNREAD", "STARRED", "INBOX", "TRASH"] {
        LabelRepository::ensure_placeholder(&connection, "account", label_id).unwrap();
    }
    let mut starting = message();
    starting.is_unread = true;
    starting.is_starred = true;
    MessageRepository::write_full_state(&connection, &starting).unwrap();
    MessageRepository::set_label_membership(&connection, "account", "message", "UNREAD", true)
        .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "message", "STARRED", true)
        .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "message", "INBOX", true)
        .unwrap();

    MessageRepository::overwrite_membership(
        &connection,
        "account",
        "message",
        &["TRASH".to_owned()],
    )
    .unwrap();

    let refreshed = MessageRepository::get(&connection, "account", "message")
        .unwrap()
        .unwrap();
    assert!(!refreshed.is_unread, "UNREAD membership was removed");
    assert!(!refreshed.is_starred, "STARRED membership was removed");
    let labels = MessageRepository::label_ids(&connection, "account", "message").unwrap();
    assert_eq!(labels, vec!["TRASH".to_owned()]);

    ThreadRepository::recompute(&connection, "account", "thread").unwrap();
    let thread = ThreadRepository::get(&connection, "account", "thread")
        .unwrap()
        .unwrap();
    assert!(!thread.is_unread);
    assert!(!thread.is_starred);
}

fn indexed_labels(connection: &rusqlite::Connection, thread_id: &str) -> Vec<(String, i64)> {
    let mut statement = connection
        .prepare(
            "SELECT label_id,latest_at FROM thread_labels WHERE account_id='account' AND thread_id=?1 ORDER BY label_id",
        )
        .unwrap();
    statement
        .query_map([thread_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

#[test]
fn thread_label_index_tracks_membership_through_recompute() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    for label_id in ["INBOX", "UNREAD", "TRASH"] {
        LabelRepository::ensure_placeholder(&connection, "account", label_id).unwrap();
    }
    let mut stored = message();
    stored.sent_at = 4_100;
    MessageRepository::write_full_state(&connection, &stored).unwrap();
    MessageRepository::set_label_membership(&connection, "account", "message", "INBOX", true)
        .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "message", "UNREAD", true)
        .unwrap();
    ThreadRepository::recompute(&connection, "account", "thread").unwrap();
    assert_eq!(
        indexed_labels(&connection, "thread"),
        vec![("INBOX".to_owned(), 4_100), ("UNREAD".to_owned(), 4_100)],
        "the index carries the thread's sort key alongside every label it holds"
    );

    MessageRepository::overwrite_membership(
        &connection,
        "account",
        "message",
        &["TRASH".to_owned()],
    )
    .unwrap();
    ThreadRepository::recompute(&connection, "account", "thread").unwrap();
    assert_eq!(
        indexed_labels(&connection, "thread"),
        vec![("TRASH".to_owned(), 4_100)],
        "labels the message no longer carries leave the index"
    );

    MessageRepository::delete(&connection, "account", "message").unwrap();
    ThreadRepository::recompute(&connection, "account", "thread").unwrap();
    assert!(
        ThreadRepository::get(&connection, "account", "thread")
            .unwrap()
            .is_none(),
        "a thread with no messages left is removed"
    );
    assert!(
        indexed_labels(&connection, "thread").is_empty(),
        "and the cascade takes its index rows with it"
    );
}

#[test]
fn all_ids_returns_every_locally_stored_message_id() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    let mut second = message();
    second.id = "message-2".into();
    MessageRepository::write_full_state(&connection, &message()).unwrap();
    MessageRepository::write_full_state(&connection, &second).unwrap();

    let ids = MessageRepository::all_ids(&connection, "account").unwrap();
    assert_eq!(ids, vec!["message".to_owned(), "message-2".to_owned()]);
}

#[test]
fn missing_ids_batches_primary_key_lookups_and_deduplicates_candidates() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    for id in ["id-0", "id-500"] {
        let stored = Message {
            id: id.into(),
            ..message()
        };
        MessageRepository::write_full_state(&connection, &stored).unwrap();
    }
    let mut candidates: Vec<String> = (0..=500).map(|id| format!("id-{id}")).collect();
    candidates.push("id-1".into());

    let missing = MessageRepository::missing_ids(&connection, "account", candidates).unwrap();

    assert_eq!(missing.len(), 499);
    assert_eq!(missing.first().map(String::as_str), Some("id-1"));
    assert_eq!(missing.last().map(String::as_str), Some("id-499"));
}

#[test]
fn hot_queries_use_their_purpose_built_indexes_without_avoidable_sorts() {
    let connection = Storage::in_memory().unwrap();
    let thread_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT id FROM threads WHERE account_id='account' ORDER BY latest_at DESC,id DESC LIMIT 51",
    );
    assert!(thread_plan
        .iter()
        .any(|step| step.contains("threads_by_latest")));
    assert!(!thread_plan.iter().any(|step| step.contains("TEMP B-TREE")));
    let cursor_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT id FROM threads WHERE account_id='account' AND (latest_at,id)<(10,'thread') ORDER BY latest_at DESC,id DESC LIMIT 51",
    );
    assert!(cursor_plan
        .iter()
        .any(|step| step.contains("threads_by_latest")));
    assert!(!cursor_plan.iter().any(|step| step.contains("TEMP B-TREE")));
    let backward_cursor_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT id FROM threads WHERE account_id='account' AND (latest_at,id)>(10,'thread') ORDER BY latest_at ASC,id ASC LIMIT 51",
    );
    assert!(backward_cursor_plan
        .iter()
        .any(|step| step.contains("threads_by_latest (account_id=? AND (latest_at,id)>(?,?))")));
    assert!(!backward_cursor_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));

    let reconciliation_new_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT r.message_id FROM reconcile_remote_messages r LEFT JOIN messages m ON m.account_id=r.account_id AND m.id=r.message_id WHERE r.account_id=?1 AND m.id IS NULL AND r.message_id>COALESCE(?2,'') ORDER BY r.message_id LIMIT ?3",
    );
    assert!(reconciliation_new_plan
        .iter()
        .any(|step| step.contains("PRIMARY KEY (account_id=? AND message_id>?)")));
    assert!(!reconciliation_new_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));
    let reconciliation_absent_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT m.id FROM messages m LEFT JOIN reconcile_remote_messages r ON r.account_id=m.account_id AND r.message_id=m.id WHERE m.account_id=?1 AND r.message_id IS NULL AND m.id>COALESCE(?2,'') ORDER BY m.id LIMIT ?3",
    );
    assert!(reconciliation_absent_plan
        .iter()
        .any(|step| step.contains("sqlite_autoindex_messages_1 (account_id=? AND id>?)")));
    assert!(!reconciliation_absent_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));
    let reconciliation_membership_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT r.message_id FROM reconcile_remote_messages r JOIN messages m ON m.account_id=r.account_id AND m.id=r.message_id WHERE r.account_id=?1 AND r.message_id>COALESCE(?2,'') AND (EXISTS (SELECT 1 FROM reconcile_remote_labels l WHERE l.account_id=r.account_id AND l.message_id=r.message_id AND NOT EXISTS (SELECT 1 FROM message_labels ml WHERE ml.account_id=l.account_id AND ml.message_id=l.message_id AND ml.label_id=l.label_id)) OR EXISTS (SELECT 1 FROM message_labels ml WHERE ml.account_id=r.account_id AND ml.message_id=r.message_id AND NOT EXISTS (SELECT 1 FROM reconcile_remote_labels l WHERE l.account_id=ml.account_id AND l.message_id=ml.message_id AND l.label_id=ml.label_id))) ORDER BY r.message_id LIMIT ?3",
    );
    assert!(reconciliation_membership_plan
        .iter()
        .any(|step| step.contains("PRIMARY KEY (account_id=? AND message_id>?)")));
    assert!(reconciliation_membership_plan
        .iter()
        .any(|step| step.contains("label_id=?")));
    assert!(!reconciliation_membership_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));
    let reconciliation_universe_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT message_id FROM reconcile_remote_messages WHERE account_id=?1 AND message_id>COALESCE(?2,'') ORDER BY message_id LIMIT ?3",
    );
    assert!(reconciliation_universe_plan
        .iter()
        .any(|step| step.contains("PRIMARY KEY (account_id=? AND message_id>?)")));
    assert!(!reconciliation_universe_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));

    let labelled_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT t.id FROM thread_labels tl CROSS JOIN threads t ON t.account_id=tl.account_id AND t.id=tl.thread_id WHERE tl.account_id='account' AND tl.label_id='INBOX' ORDER BY tl.latest_at DESC,tl.thread_id DESC LIMIT 51",
    );
    assert!(labelled_plan
        .iter()
        .any(|step| step.contains("SEARCH tl USING PRIMARY KEY")));
    assert!(!labelled_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));
    assert!(!labelled_plan.iter().any(|step| step.contains("SCAN")));
    let labelled_cursor_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT t.id FROM thread_labels tl CROSS JOIN threads t ON t.account_id=tl.account_id AND t.id=tl.thread_id WHERE tl.account_id='account' AND tl.label_id='INBOX' AND (tl.latest_at,tl.thread_id)<(10,'thread') ORDER BY tl.latest_at DESC,tl.thread_id DESC LIMIT 51",
    );
    assert!(labelled_cursor_plan
        .iter()
        .any(|step| step.contains("(latest_at,thread_id)<(?,?)")));
    assert!(!labelled_cursor_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));
    let unread_count_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT tl.label_id,COUNT(*) FROM threads t CROSS JOIN thread_labels tl ON tl.account_id=t.account_id AND tl.thread_id=t.id WHERE t.account_id='account' AND t.is_unread=1 GROUP BY tl.label_id",
    );
    assert!(unread_count_plan
        .iter()
        .any(|step| step.contains("SEARCH t USING INDEX threads_unread")));
    assert!(unread_count_plan
        .iter()
        .any(|step| step.contains("COVERING INDEX thread_labels_by_thread")));
    assert!(!unread_count_plan.iter().any(|step| step.contains("SCAN")));

    let thread_cascade_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN DELETE FROM thread_labels WHERE account_id='account' AND thread_id='thread'",
    );
    assert!(thread_cascade_plan
        .iter()
        .any(|step| step.contains("thread_labels_by_thread")));

    let labelled_listing_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT t.account_id,t.id,t.subject,t.participants,tl.latest_at,t.message_count,t.is_unread,t.is_starred,t.has_attachments,t.has_draft,t.sender_identity,t.recipient_identity,COALESCE((SELECT m2.snippet FROM messages m2 WHERE m2.account_id=t.account_id AND m2.thread_id=t.id ORDER BY m2.sent_at DESC,m2.id DESC LIMIT 1),'') FROM thread_labels tl CROSS JOIN threads t ON t.account_id=tl.account_id AND t.id=tl.thread_id WHERE tl.account_id=?1 AND tl.label_id=?2 ORDER BY tl.latest_at DESC,tl.thread_id DESC LIMIT ?5",
    );
    assert!(labelled_listing_plan
        .iter()
        .any(|step| step.contains("SEARCH tl USING PRIMARY KEY (account_id=? AND label_id=?)")));
    assert!(labelled_listing_plan
        .iter()
        .any(|step| step.contains("SEARCH m2 USING INDEX messages_by_thread")));
    assert!(!labelled_listing_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));
    assert!(!labelled_listing_plan
        .iter()
        .any(|step| step.contains("SCAN")));

    let embedding_backlog_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT m.seq,m.sender,m.recipients,m.subject,m.plain_body,m.html_body,m.truncated_body FROM messages m WHERE m.seq IN (SELECT k.seq FROM messages k WHERE k.account_id=?1 AND NOT EXISTS (SELECT 1 FROM message_embeddings e WHERE e.account_id=k.account_id AND e.message_seq=k.seq) AND NOT EXISTS (SELECT 1 FROM message_labels l WHERE l.account_id=k.account_id AND l.message_id=k.id AND l.label_id IN ('TRASH','SPAM','DRAFT')) LIMIT ?2)",
    );
    assert!(
        embedding_backlog_plan.iter().any(|step| step.contains(
            "SEARCH k USING COVERING INDEX sqlite_autoindex_messages_1 (account_id=?)"
        )),
        "the embedding backlog must pick candidate rows from a covering index, never by scanning the message bodies"
    );
    assert!(embedding_backlog_plan.iter().any(|step| step.contains(
        "SEARCH e USING COVERING INDEX message_embeddings_by_account_message (account_id=? AND message_seq=?)"
    )));
    assert!(embedding_backlog_plan
        .iter()
        .any(|step| step.contains("SEARCH m USING INTEGER PRIMARY KEY (rowid=?)")));
    assert!(!embedding_backlog_plan
        .iter()
        .any(|step| step.contains("SCAN m") || step.contains("SCAN k")));
    assert!(!embedding_backlog_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));

    let embedding_total_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT (SELECT COUNT(*) FROM messages WHERE account_id=?1)-(SELECT COUNT(DISTINCT message_id) FROM message_labels WHERE account_id=?1 AND label_id IN ('TRASH','SPAM','DRAFT'))",
    );
    assert!(embedding_total_plan.iter().any(|step| step.contains(
        "SEARCH messages USING COVERING INDEX sqlite_autoindex_messages_1 (account_id=?)"
    )));
    assert!(embedding_total_plan.iter().any(|step| step.contains(
        "SEARCH message_labels USING COVERING INDEX sqlite_autoindex_message_labels_1 (account_id=?)"
    )));
    assert!(
        !embedding_total_plan
            .iter()
            .any(|step| step.contains("TEMP B-TREE")),
        "the eligible-message count must read message_id in index order so DISTINCT needs no sort"
    );

    let label_index_write_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN INSERT INTO thread_labels (account_id,label_id,thread_id,latest_at) SELECT ?1,CASE WHEN EXISTS (SELECT 1 FROM message_labels x WHERE x.account_id=?1 AND x.message_id=m.id AND x.label_id='TRASH') THEN 'TRASH' WHEN EXISTS (SELECT 1 FROM message_labels x WHERE x.account_id=?1 AND x.message_id=m.id AND x.label_id='SPAM') THEN 'SPAM' ELSE ml.label_id END,?2,MAX(m.sent_at) FROM messages m CROSS JOIN message_labels ml ON ml.account_id=m.account_id AND ml.message_id=m.id WHERE m.account_id=?1 AND m.thread_id=?2 GROUP BY 2",
    );
    assert!(label_index_write_plan.iter().any(|step| step.contains(
        "SEARCH m USING COVERING INDEX messages_by_thread (account_id=? AND thread_id=?)"
    )));
    assert!(label_index_write_plan.iter().any(|step| step.contains(
        "SEARCH x USING COVERING INDEX sqlite_autoindex_message_labels_1 (account_id=? AND message_id=? AND label_id=?)"
    )));
    assert!(
        !label_index_write_plan
            .iter()
            .any(|step| step.contains("MATERIALIZE") || step.contains("SCAN")),
        "the per-thread label index write must stay driven by messages_by_thread, never materialise a per-account aggregate"
    );

    let message_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT snippet FROM messages WHERE account_id='account' AND thread_id='thread' ORDER BY sent_at DESC,id DESC LIMIT 1",
    );
    assert!(message_plan
        .iter()
        .any(|step| step.contains("messages_by_thread")));
    assert!(!message_plan.iter().any(|step| step.contains("TEMP B-TREE")));

    let visible_count_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT m.thread_id,COUNT(*) FROM messages m WHERE m.account_id='account' AND m.thread_id IN ('thread-1','thread-2') AND NOT EXISTS (SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id IN ('TRASH','SPAM')) GROUP BY m.thread_id",
    );
    assert!(visible_count_plan
        .iter()
        .any(|step| step.contains("COVERING INDEX messages_by_thread")));
    assert!(visible_count_plan
        .iter()
        .any(|step| step.contains("COVERING INDEX sqlite_autoindex_message_labels_1")));
    assert!(!visible_count_plan
        .iter()
        .any(|step| step.contains("SCAN m") || step.contains("SCAN ml")));
    assert!(!visible_count_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));

    let embedding_backlog_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT m.seq FROM messages m WHERE m.account_id='account' AND NOT EXISTS (SELECT 1 FROM message_embeddings e WHERE e.account_id=m.account_id AND e.message_seq=m.seq) AND NOT EXISTS (SELECT 1 FROM message_labels l WHERE l.account_id=m.account_id AND l.message_id=m.id AND l.label_id IN ('TRASH','SPAM','DRAFT')) LIMIT 64",
    );
    assert!(embedding_backlog_plan
        .iter()
        .any(|step| step.contains("message_embeddings_by_account_message")));
    assert!(!embedding_backlog_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));

    let embedding_count_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT COUNT(DISTINCT message_seq) FROM message_embeddings WHERE account_id='account'",
    );
    assert!(embedding_count_plan
        .iter()
        .any(|step| step.contains("message_embeddings_by_account_message")));
    assert!(!embedding_count_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));

    let embedding_passage_count_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM message_embeddings WHERE account_id='account'",
    );
    assert!(embedding_passage_count_plan
        .iter()
        .any(|step| step.contains("message_embeddings_by_account_message")));
    assert!(!embedding_passage_count_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));

    let draft_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE account_id='account' AND draft_id='draft'",
    );
    assert!(draft_plan
        .iter()
        .any(|step| step.contains("messages_by_draft")));

    let contact_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT address FROM contacts WHERE account_id='account' AND address LIKE 'a%'",
    );
    assert!(contact_plan
        .iter()
        .any(|step| step.contains("contacts_lookup")));

    let operation_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT id FROM operations WHERE kind IN ('send','draft') AND status='queued' ORDER BY created_at",
    );
    assert!(operation_plan
        .iter()
        .any(|step| step.contains("operations_queued_durable")));
    assert!(!operation_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));
    let active_draft_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN UPDATE operations SET status='queued' WHERE kind='draft' AND status='active'",
    );
    assert!(active_draft_plan
        .iter()
        .any(|step| step.contains("operations_active_drafts")));
    let account_operation_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT id FROM operations WHERE account_id='account'",
    );
    assert!(account_operation_plan
        .iter()
        .any(|step| step.contains("operations_by_account")));

    let failed_durable_scoped_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT id FROM operations WHERE kind IN ('send','draft') AND status='failed' AND account_id='account' ORDER BY created_at",
    );
    assert!(failed_durable_scoped_plan
        .iter()
        .any(|step| step.contains("operations_failed_durable")));
    assert!(!failed_durable_scoped_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));

    let mut statement = connection.prepare("PRAGMA index_list(messages)").unwrap();
    let message_indexes = statement
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(!message_indexes
        .iter()
        .any(|name| name == "messages_by_history"));

    let search_text_term_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT t.id FROM message_search JOIN messages m ON m.seq=message_search.rowid JOIN threads t ON t.account_id=m.account_id AND t.id=m.thread_id WHERE message_search MATCH 'x' AND m.account_id='account' GROUP BY t.id ORDER BY t.latest_at DESC, t.id DESC LIMIT 51",
    );
    assert!(search_text_term_plan
        .iter()
        .any(|step| step.contains("SCAN message_search VIRTUAL TABLE INDEX 0:M4")));
    assert_eq!(
        search_text_term_plan
            .iter()
            .filter(|step| step.contains("TEMP B-TREE"))
            .count(),
        2
    );
    let backward_search_text_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT t.id FROM message_search JOIN messages m ON m.seq=message_search.rowid JOIN threads t ON t.account_id=m.account_id AND t.id=m.thread_id WHERE message_search MATCH 'x' AND m.account_id='account' AND (t.latest_at,t.id)>(1,'t') GROUP BY t.id ORDER BY t.latest_at ASC, t.id ASC LIMIT 51",
    );
    assert_eq!(
        backward_search_text_plan
            .iter()
            .filter(|step| step.contains("TEMP B-TREE"))
            .count(),
        2
    );

    let search_predicate_only_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT t.id FROM threads t WHERE t.account_id='account' AND EXISTS(SELECT 1 FROM messages m WHERE m.account_id=t.account_id AND m.thread_id=t.id AND m.is_unread=1) ORDER BY t.latest_at DESC, t.id DESC LIMIT 51",
    );
    assert!(search_predicate_only_plan.iter().any(
        |step| step.contains("SEARCH t USING COVERING INDEX threads_by_latest (account_id=?)")
    ));
    assert!(search_predicate_only_plan
        .iter()
        .any(|step| step.contains("SEARCH m USING INDEX messages_by_thread")));
    assert!(!search_predicate_only_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));

    let search_predicate_cursor_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT t.id FROM threads t WHERE t.account_id='account' AND (t.latest_at,t.id)<(1,'t') AND EXISTS(SELECT 1 FROM messages m WHERE m.account_id=t.account_id AND m.thread_id=t.id AND m.is_unread=1) ORDER BY t.latest_at DESC, t.id DESC LIMIT 51",
    );
    assert!(search_predicate_cursor_plan.iter().any(|step| step
        .contains("SEARCH t USING COVERING INDEX threads_by_latest (account_id=? AND (latest_at,id)<(?,?))")));
    assert!(!search_predicate_cursor_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));
    let backward_search_predicate_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT t.id FROM threads t WHERE t.account_id='account' AND (t.latest_at,t.id)>(1,'t') AND EXISTS(SELECT 1 FROM messages m WHERE m.account_id=t.account_id AND m.thread_id=t.id AND m.is_unread=1) ORDER BY t.latest_at ASC, t.id ASC LIMIT 51",
    );
    assert!(backward_search_predicate_plan
        .iter()
        .any(|step| step.contains("threads_by_latest (account_id=? AND (latest_at,id)>(?,?))")));
    assert!(!backward_search_predicate_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));

    AccountRepository::upsert(&connection, &account()).unwrap();
    EmbeddingRepository::create(&connection, "account", 2).unwrap();
    let table = EmbeddingRepository::table_name(1);
    let candidate_plan = query_plan(
        &connection,
        &format!(
            "EXPLAIN QUERY PLAN {}",
            RetrievalRepository::candidate_sql(&table, false)
        ),
    );
    assert!(
        candidate_plan
            .iter()
            .any(|step| step.contains("SCAN v VIRTUAL TABLE")),
        "the assistant's candidate read must drive from the vector table's nearest-neighbour search"
    );
    assert!(candidate_plan
        .iter()
        .any(|step| step.contains("SEARCH e USING INTEGER PRIMARY KEY (rowid=?)")));
    assert!(candidate_plan
        .iter()
        .any(|step| step.contains("SEARCH m USING INTEGER PRIMARY KEY (rowid=?)")));
    assert!(!candidate_plan
        .iter()
        .any(|step| step.contains("SCAN e") || step.contains("SCAN m")));
    assert!(!candidate_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));

    let filtered_plan = query_plan(
        &connection,
        &format!(
            "EXPLAIN QUERY PLAN {}",
            RetrievalRepository::candidate_sql(&table, true)
        ),
    );
    assert!(
        filtered_plan
            .iter()
            .any(|step| step.contains("SCAN v VIRTUAL TABLE")),
        "the filtered candidate read must still drive from the vector search"
    );
    assert!(
        filtered_plan
            .iter()
            .any(|step| step.contains("LIST SUBQUERY")),
        "the filters must reach the vector search as a rowid list, not run after it"
    );
    assert!(filtered_plan
        .iter()
        .any(|step| step.contains("SEARCH f USING INTEGER PRIMARY KEY (rowid=?)")));
    assert!(filtered_plan.iter().any(|step| step.contains(
        "SEARCH ml USING COVERING INDEX sqlite_autoindex_message_labels_1 (account_id=? AND message_id=?)"
    )));
    assert!(!filtered_plan
        .iter()
        .any(|step| step.contains("SCAN f") || step.contains("SCAN ml")));
    assert!(!filtered_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE")));

    let sources_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT m.seq,m.id,m.thread_id,m.sender,m.recipients,m.subject,m.sent_at,m.plain_body,m.html_body,m.truncated_body FROM json_each(?2) r CROSS JOIN messages m ON m.seq=r.value WHERE m.account_id=?1",
    );
    assert!(
        sources_plan
            .iter()
            .any(|step| step.contains("SEARCH m USING INTEGER PRIMARY KEY (rowid=?)")),
        "citation sources must be one batched rowid lookup, not a query per passage"
    );
    assert!(!sources_plan
        .iter()
        .any(|step| step.contains("SCAN m ") || step.contains("TEMP B-TREE")));

    let lexical_relevance_plan = query_plan(
        &connection,
        &format!(
            "EXPLAIN QUERY PLAN {}",
            RetrievalRepository::LEXICAL_RELEVANCE_SQL
        ),
    );
    assert!(
        lexical_relevance_plan
            .iter()
            .any(|step| step.contains("SCAN message_search VIRTUAL TABLE INDEX 32:M4")),
        "the lexical relevance read must drive from the rank-ordered match"
    );
    assert!(lexical_relevance_plan
        .iter()
        .any(|step| step.contains("SEARCH m USING INTEGER PRIMARY KEY (rowid=?)")));
    assert_eq!(
        lexical_relevance_plan
            .iter()
            .filter(|step| step.contains("TEMP B-TREE"))
            .count(),
        0
    );

    let lexical_chronological_plan = query_plan(
        &connection,
        &format!(
            "EXPLAIN QUERY PLAN {}",
            RetrievalRepository::LEXICAL_CHRONOLOGICAL_SQL
        ),
    );
    assert!(
        lexical_chronological_plan
            .iter()
            .any(|step| step.contains("SCAN message_search VIRTUAL TABLE INDEX 0:M4")),
        "the lexical chronological read must still drive from the match, not from every message"
    );
    assert!(lexical_chronological_plan
        .iter()
        .any(|step| step.contains("SEARCH m USING INTEGER PRIMARY KEY (rowid=?)")));
}

#[test]
fn every_rowid_table_carries_a_leading_autoincrement_seq_and_its_former_key_as_a_unique_constraint()
{
    let connection = Storage::in_memory().unwrap();

    let single_key_tables = [
        ("accounts", "id"),
        ("settings", "key"),
        ("operations", "id"),
        ("avatar_cache", "cache_key"),
    ];
    for (table, former_key) in single_key_tables {
        let columns = table_columns(&connection, table);
        let (first_name, _, first_pk) = &columns[0];
        assert_eq!(first_name, "seq", "{table}'s first column must be seq");
        assert_eq!(*first_pk, 1, "{table}.seq must be the table's primary key");
        let (_, former_key_not_null, former_key_pk) = columns
            .iter()
            .find(|(name, _, _)| name == former_key)
            .unwrap_or_else(|| panic!("{table} lost its former key column {former_key}"));
        assert!(
            *former_key_not_null,
            "{table}.{former_key} must stay NOT NULL"
        );
        assert_eq!(
            *former_key_pk, 0,
            "{table}.{former_key} must no longer be the primary key"
        );
        let unique_sets = unique_indexed_column_sets(&connection, table);
        assert!(
            unique_sets
                .iter()
                .any(|set| set == &[former_key.to_owned()]),
            "{table}.{former_key} must be covered by a UNIQUE constraint"
        );
    }

    let composite_key_tables = [
        ("labels", vec!["account_id", "id"]),
        ("messages", vec!["account_id", "id"]),
        (
            "message_labels",
            vec!["account_id", "message_id", "label_id"],
        ),
        ("threads", vec!["account_id", "id"]),
        (
            "message_inline_parts",
            vec!["account_id", "message_id", "content_id"],
        ),
        ("traversal_cursors", vec!["account_id", "kind"]),
        ("contacts", vec!["account_id", "address"]),
        ("compose_draft_metadata", vec!["account_id", "draft_id"]),
    ];
    for (table, former_key) in composite_key_tables {
        let columns = table_columns(&connection, table);
        let (first_name, _, first_pk) = &columns[0];
        assert_eq!(first_name, "seq", "{table}'s first column must be seq");
        assert_eq!(*first_pk, 1, "{table}.seq must be the table's primary key");
        for column in &former_key {
            let (_, not_null, pk) = columns
                .iter()
                .find(|(name, _, _)| name == column)
                .unwrap_or_else(|| panic!("{table} lost its former key column {column}"));
            assert!(*not_null, "{table}.{column} must stay NOT NULL");
            assert_eq!(*pk, 0, "{table}.{column} must no longer be the primary key");
        }
        let expected: Vec<String> = former_key.iter().map(|column| column.to_string()).collect();
        let unique_sets = unique_indexed_column_sets(&connection, table);
        assert!(
            unique_sets.iter().any(|set| set == &expected),
            "{table} must retain {former_key:?} as a UNIQUE constraint"
        );
    }

    let columns = table_columns(&connection, "message_embeddings");
    assert_eq!(columns[0].0, "seq");
    assert_eq!(columns[0].2, 1);
    assert!(columns
        .iter()
        .find(|(name, _, _)| name == "account_id")
        .is_some_and(|(_, not_null, pk)| *not_null && *pk == 0));
    assert!(
        unique_indexed_column_sets(&connection, "message_embeddings")
            .iter()
            .any(|columns| columns == &["message_seq".to_owned(), "chunk_index".to_owned()])
    );
    let foreign_keys = connection
        .prepare("PRAGMA foreign_key_list(message_embeddings)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(2))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(foreign_keys, vec!["messages"]);
}

#[test]
fn embedding_migrations_preserve_populated_v8_data_and_foreign_keys() {
    let connection = rusqlite::Connection::open_in_memory().unwrap();
    for migration in [
        include_str!("../../migrations/V1__initial_schema.sql"),
        include_str!("../../migrations/V2__derive_label_unread_counts.sql"),
        include_str!("../../migrations/V3__failed_durable_operations_index.sql"),
        include_str!("../../migrations/V4__message_attachments.sql"),
        include_str!("../../migrations/V5__reconcile_staging.sql"),
        include_str!("../../migrations/V6__drop_reconcile_remote_labels_index.sql"),
        include_str!("../../migrations/V7__per_label_thread_latest_at.sql"),
        include_str!("../../migrations/V8__account_ai_config.sql"),
    ] {
        connection.execute_batch(migration).unwrap();
    }
    connection
        .execute(
            "INSERT INTO accounts(id,email,display_name,created_at,updated_at) VALUES ('account','mail@example.com','Mail',1,1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO messages(account_id,id,thread_id,sender,recipients,subject,sent_at,history_id) VALUES ('account','message','thread','sender','recipient','Subject',1,1)",
            [],
        )
        .unwrap();
    connection
        .execute_batch(include_str!("../../migrations/V9__message_embeddings.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!(
            "../../migrations/V10__repair_embedding_invalidation_triggers.sql"
        ))
        .unwrap();
    connection
        .execute(
            "INSERT INTO message_embeddings(account_id,message_seq,chunk_index) VALUES ('account',1,0)",
            [],
        )
        .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}

#[test]
fn thread_labels_stays_without_rowid_with_no_integer_key() {
    let connection = Storage::in_memory().unwrap();
    let columns = table_columns(&connection, "thread_labels");
    assert!(
        columns.iter().all(|(name, _, _)| name != "seq"),
        "thread_labels must not gain an integer key"
    );
    let schema: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='thread_labels'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(schema.contains("WITHOUT ROWID"));

    let mut statement = connection
        .prepare("PRAGMA index_list(thread_labels)")
        .unwrap();
    let indexes: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(indexes.iter().any(|name| name == "thread_labels_by_thread"));
}

#[test]
fn message_labels_by_label_index_survives_the_squash() {
    let connection = Storage::in_memory().unwrap();
    let mut statement = connection
        .prepare("PRAGMA index_list(message_labels)")
        .unwrap();
    let indexes: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(indexes.iter().any(|name| name == "message_labels_by_label"));
}

#[test]
fn a_fresh_database_migrates_cleanly_with_no_foreign_key_violations() {
    let connection = Storage::in_memory().unwrap();
    let mut statement = connection.prepare("PRAGMA foreign_key_check").unwrap();
    let violations = statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(
        violations.is_empty(),
        "unexpected FK violations: {violations:?}"
    );
}

#[test]
fn set_truncated_body_overwrites_and_clears_the_stored_snippet() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    MessageRepository::write_full_state(&connection, &message()).unwrap();

    MessageRepository::set_truncated_body(&connection, "account", "message", Some("truncated"))
        .unwrap();
    assert_eq!(
        MessageRepository::get(&connection, "account", "message")
            .unwrap()
            .unwrap()
            .truncated_body,
        Some("truncated".to_owned())
    );

    MessageRepository::set_truncated_body(&connection, "account", "message", None).unwrap();
    assert_eq!(
        MessageRepository::get(&connection, "account", "message")
            .unwrap()
            .unwrap()
            .truncated_body,
        None
    );
}

#[test]
fn label_colour_pair_round_trips_and_is_absent_by_default() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    let mut label = Label {
        account_id: "account".into(),
        id: "Label_1".into(),
        name: "Clients".into(),
        kind: "user".into(),
        color: None,
        message_count: 0,
    };
    LabelRepository::upsert(&connection, &label).unwrap();
    assert_eq!(
        LabelRepository::get(&connection, "account", "Label_1")
            .unwrap()
            .unwrap()
            .color,
        None
    );

    label.color = Some(LabelColor {
        text: "#ffffff".into(),
        background: "#4a86e8".into(),
    });
    LabelRepository::upsert(&connection, &label).unwrap();
    assert_eq!(
        LabelRepository::get(&connection, "account", "Label_1")
            .unwrap()
            .unwrap()
            .color,
        label.color
    );
}

#[test]
fn validate_name_rejects_every_rule_distinguishably() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    assert_eq!(
        LabelRepository::validate_name(&connection, "account", "", None),
        Err(LabelNameError::Empty)
    );
    assert_eq!(
        LabelRepository::validate_name(&connection, "account", "a\\b", None),
        Err(LabelNameError::ForbiddenCharacters)
    );
}

#[tokio::test]
async fn storage_offloads_database_work() {
    let path = tempfile::NamedTempFile::new().unwrap();
    let storage = Storage::open(path.path()).unwrap();
    storage
        .run(|connection| {
            connection.execute(
                "INSERT INTO settings (key,value) VALUES ('theme','light')",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        storage
            .run(|connection| connection.query_row(
                "SELECT value FROM settings WHERE key='theme'",
                [],
                |row| row.get::<_, String>(0)
            ))
            .await
            .unwrap(),
        "light"
    );
}

#[test]
fn message_attachments_round_trip_in_sender_order_and_cascade_delete_on_an_index() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    MessageRepository::write_full_state(&connection, &message()).unwrap();

    let attachments = vec![
        Attachment {
            attachment_id: "att-2".into(),
            filename: "second.pdf".into(),
            mime_type: "application/pdf".into(),
            size: 200,
            position: 1,
        },
        Attachment {
            attachment_id: "att-1".into(),
            filename: "first.pdf".into(),
            mime_type: "application/pdf".into(),
            size: 100,
            position: 0,
        },
    ];
    AttachmentRepository::replace_for_message(&connection, "account", "message", &attachments)
        .unwrap();

    let stored = AttachmentRepository::for_message(&connection, "account", "message").unwrap();
    assert_eq!(
        stored
            .iter()
            .map(|value| value.attachment_id.as_str())
            .collect::<Vec<_>>(),
        vec!["att-1", "att-2"],
        "attachments must read back ordered by sender position, not insertion order"
    );
    assert_eq!(
        AttachmentRepository::get(&connection, "account", "message", "att-1")
            .unwrap()
            .unwrap()
            .filename,
        "first.pdf"
    );

    let mut statement = connection.prepare("PRAGMA foreign_key_check").unwrap();
    let violations = statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(
        violations.is_empty(),
        "unexpected FK violations: {violations:?}"
    );

    let cascade_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN DELETE FROM message_attachments WHERE account_id='account' AND message_id='message'",
    );
    assert!(cascade_plan
        .iter()
        .any(|step| step.contains("message_attachments") || step.contains("SEARCH")));
    assert!(!cascade_plan
        .iter()
        .any(|step| step.contains("SCAN message_attachments")));

    MessageRepository::delete(&connection, "account", "message").unwrap();
    assert!(
        AttachmentRepository::for_message(&connection, "account", "message")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn conversation_payload_joins_are_index_driven_and_carry_no_visibility_subquery() {
    let connection = Storage::in_memory().unwrap();
    let attachment_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT a.message_id,a.attachment_id
         FROM messages m CROSS JOIN message_attachments a
         WHERE m.account_id='account' AND m.thread_id='thread'
           AND a.account_id=m.account_id AND a.message_id=m.id",
    );
    assert!(attachment_plan.iter().any(|step| step.contains("SEARCH a")));
    assert!(!attachment_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE") || step.contains("SCAN a")));
    assert!(!attachment_plan.iter().any(|step| step.contains("SUBQUERY")));

    let inline_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT content_id FROM message_inline_parts WHERE account_id='account' AND message_id='message'",
    );
    assert!(inline_plan
        .iter()
        .any(|step| step.contains("message_inline_parts")));
    assert!(!inline_plan.iter().any(|step| step.contains("TEMP B-TREE")));
    assert!(!inline_plan.iter().any(|step| step.contains("SUBQUERY")));

    let label_plan = query_plan(
        &connection,
        "EXPLAIN QUERY PLAN SELECT ml.message_id,ml.label_id
         FROM messages m CROSS JOIN message_labels ml
         WHERE m.account_id='account' AND m.thread_id='thread'
           AND ml.account_id=m.account_id AND ml.message_id=m.id",
    );
    assert!(label_plan.iter().any(|step| step.contains("SEARCH ml")));
    assert!(!label_plan
        .iter()
        .any(|step| step.contains("TEMP B-TREE") || step.contains("SCAN ml")));
    assert!(!label_plan.iter().any(|step| step.contains("SUBQUERY")));
}

#[test]
fn conversation_scope_uses_message_label_membership_without_a_temp_b_tree() {
    let connection = Storage::in_memory().unwrap();
    let plan = query_plan(&connection, "EXPLAIN QUERY PLAN SELECT m.id FROM messages m WHERE m.account_id='account' AND m.thread_id='thread' AND NOT EXISTS (SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id IN ('TRASH','SPAM')) ORDER BY m.sent_at,m.id");
    assert!(plan.iter().any(|step| step.contains("SEARCH ml")));
    assert!(!plan.iter().any(|step| step.contains("TEMP B-TREE")));
    assert!(!plan.iter().any(|step| step.contains("SCAN ml")));
}
