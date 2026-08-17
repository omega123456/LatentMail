
use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, Message, MessageRepository, Storage,
};

fn message(presence: HtmlPresence) -> Message {
    Message {
        account_id: "account".into(),
        id: "message".into(),
        thread_id: "thread".into(),
        rfc_message_id: None,
        sender: "sender@example.com".into(),
        recipients: String::new(),
        subject: "Subject".into(),
        sent_at: 1,
        snippet: "snippet".into(),
        html_body: None,
        plain_body: None,
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id: 1,
        truncated_body: Some("cut off embedding text".into()),
        html_presence: presence,
    }
}

#[test]
fn lazy_body_cache_distinguishes_never_fetched_present_and_absent() {
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
    MessageRepository::write_full_state(&connection, &message(HtmlPresence::NeverFetched)).unwrap();
    assert_eq!(
        MessageRepository::get(&connection, "account", "message")
            .unwrap()
            .unwrap()
            .html_presence,
        HtmlPresence::NeverFetched
    );
    assert!(MessageRepository::get(&connection, "account", "message")
        .unwrap()
        .unwrap()
        .body_is_empty());
    MessageRepository::set_body(
        &connection,
        "account",
        "message",
        Some("<p>full body</p>"),
        None,
        HtmlPresence::Present,
    )
    .unwrap();
    let cached = MessageRepository::get(&connection, "account", "message")
        .unwrap()
        .unwrap();
    assert_eq!(cached.html_body.as_deref(), Some("<p>full body</p>"));
    assert_eq!(cached.html_presence, HtmlPresence::Present);
    assert!(!cached.body_is_empty());
    MessageRepository::set_body(
        &connection,
        "account",
        "message",
        None,
        Some("plain-only bounce notice"),
        HtmlPresence::Absent,
    )
    .unwrap();
    let absent = MessageRepository::get(&connection, "account", "message")
        .unwrap()
        .unwrap();
    assert_eq!(absent.html_presence, HtmlPresence::Absent);
    assert!(absent.html_body.is_none());

    assert_eq!(absent.plain_body.as_deref(), Some("plain-only bounce notice"));
    assert!(!absent.body_is_empty());
}
