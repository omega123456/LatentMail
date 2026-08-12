use latentmail_lib::storage::{
    truncate_body, Account, AccountRepository, HtmlPresence, Label, LabelColor, LabelNameError,
    LabelRepository, Message, MessageRepository, Operation, OperationRepository,
    SettingRepository, Storage, Thread, ThreadRepository, TraversalCursor,
    TraversalCursorRepository, TraversalKind,
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
        unread_count: 1,
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

/// AC2: the three HTML-presence states are distinguishable — not just
/// `html_body IS NULL` collapsing "never fetched" and "genuinely absent"
/// into the same thing.
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

    MessageRepository::set_html_body(
        &connection,
        "account",
        "backfilled",
        None,
        HtmlPresence::Absent,
    )
    .unwrap();
    let absent = MessageRepository::get(&connection, "account", "backfilled")
        .unwrap()
        .unwrap();
    assert_eq!(absent.html_presence, HtmlPresence::Absent);
    assert!(absent.html_body.is_none());

    MessageRepository::set_html_body(
        &connection,
        "account",
        "backfilled",
        Some("<p>hi</p>"),
        HtmlPresence::Present,
    )
    .unwrap();
    let present = MessageRepository::get(&connection, "account", "backfilled")
        .unwrap()
        .unwrap();
    assert_eq!(present.html_presence, HtmlPresence::Present);
    assert_eq!(present.html_body.as_deref(), Some("<p>hi</p>"));
}

/// AC3: capped at 10,000 characters, preferring plain text over
/// tag-stripped HTML when both are available.
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

/// AC4: cursor state round-trips and survives reopening the database. Also
/// covers the D3 fix (migration `V4__traversal_cursor_composite_key`):
/// backfill and reconciliation cursors for the same account are keyed by
/// `(account_id, kind)`, so an upsert for one kind updates only that row —
/// it neither creates nor clobbers the other kind's row — and each can be
/// deleted independently of the other.
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

    // Upserting the *same* kind updates the existing row in place.
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

    // Upserting a *different* kind for the same account creates its own,
    // independent row rather than overwriting the backfill row above — this
    // is the exact bug the composite key fixes.
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

    // Deleting one kind leaves the other's row intact.
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

/// AC5: bulk membership overwrite leaves the denormalised `is_unread`/
/// `is_starred` columns consistent with actual membership, and thread
/// recomputation aggregates from the corrected rows.
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

    // Reconciliation-style overwrite: server says the message is now read,
    // unstarred, and only in Trash.
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

/// The reconciliation diff (Phase 5) needs the universe of locally stored
/// ids; no prior method exposed one.
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

/// AC6 (schema half): a label's colour pair round-trips, present only when
/// explicitly set.
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
        unread_count: 0,
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
