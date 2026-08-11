use latentmail_lib::storage::{
    Account, AccountRepository, Label, LabelRepository, Message, MessageRepository, Operation,
    OperationRepository, SettingRepository, Storage, Thread, ThreadRepository,
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
