use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, Message, MessageRepository, Storage,
};

fn message(history_id: i64, subject: &str) -> Message {
    Message {
        account_id: "account".into(),
        id: "message".into(),
        thread_id: "thread".into(),
        rfc_message_id: None,
        sender: "sender@example.com".into(),
        recipients: "recipient@example.com".into(),
        subject: subject.into(),
        sent_at: 1,
        snippet: String::new(),
        html_body: None,
        plain_body: None,
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id,
        truncated_body: None,
        html_presence: HtmlPresence::Absent,
    }
}
fn connection() -> rusqlite::Connection {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "mail@example.com".into(),
            display_name: "Mail".into(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    connection
}
#[test]
fn full_state_requires_a_strictly_newer_history_id() {
    let connection = connection();
    assert!(MessageRepository::write_full_state(&connection, &message(10, "new")).unwrap());
    assert!(!MessageRepository::write_full_state(&connection, &message(10, "equal")).unwrap());
    assert!(!MessageRepository::write_full_state(&connection, &message(9, "old")).unwrap());
    assert_eq!(
        MessageRepository::get(&connection, "account", "message")
            .unwrap()
            .unwrap()
            .subject,
        "new"
    );
    assert!(MessageRepository::write_full_state(&connection, &message(11, "newest")).unwrap());
}
#[test]
fn mutation_history_write_back_blocks_an_older_full_read() {
    let connection = connection();
    assert!(
        MessageRepository::write_full_state(&connection, &message(10, "before mutation")).unwrap()
    );
    assert_eq!(
        MessageRepository::write_mutation_history(&connection, "account", &["message".into()], 20)
            .unwrap(),
        1
    );
    assert!(!MessageRepository::write_full_state(&connection, &message(15, "stale read")).unwrap());
    assert_eq!(
        MessageRepository::get(&connection, "account", "message")
            .unwrap()
            .unwrap()
            .history_id,
        20
    );
}
