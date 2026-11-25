use latentmail_lib::sync::materialize::DraftReplacement;
use latentmail_lib::{
    gmail::GmailMessage,
    storage::{Account, AccountRepository, MessageRepository, Storage},
    sync::materialize,
};

fn message(id: &str, thread_id: &str) -> GmailMessage {
    GmailMessage {
        id: id.into(),
        thread_id: thread_id.into(),
        history_id: 1,
        label_ids: vec!["DRAFT".into()],
        snippet: String::new(),
        sent_at: 1,
        rfc_message_id: None,
        sender: "me@example.com".into(),
        recipients: "to@example.com".into(),
        to_recipients: "to@example.com".into(),
        cc_recipients: String::new(),
        bcc_recipients: String::new(),
        rfc_references: None,
        subject: "Subject".into(),
        html_body: None,
        plain_body: Some("body".into()),
        has_attachments: false,
        inline_parts: Vec::new(),
        attachment_parts: Vec::new(),
        oversize: false,
    }
}

fn connection_with_account() -> rusqlite::Connection {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "a".into(),
            email: "me@example.com".into(),
            display_name: "Me".into(),
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
fn draft_replacement_tracks_the_stable_draft_id_across_gmail_message_ids() {
    let connection = connection_with_account();

    materialize::replace_draft(
        &connection,
        DraftReplacement {
            account_id: "a",
            draft_id: "d1",
            replacement: &message("m1", "t1"),
            consumed: false,
        },
    )
    .unwrap();
    materialize::replace_draft(
        &connection,
        DraftReplacement {
            account_id: "a",
            draft_id: "d1",
            replacement: &message("m2", "t2"),
            consumed: false,
        },
    )
    .unwrap();

    assert!(MessageRepository::get(&connection, "a", "m1")
        .unwrap()
        .is_none());
    assert_eq!(
        MessageRepository::draft_id(&connection, "a", "m2")
            .unwrap()
            .as_deref(),
        Some("d1")
    );
    materialize::replace_draft(
        &connection,
        DraftReplacement {
            account_id: "a",
            draft_id: "d1",
            replacement: &message("sent", "t2"),
            consumed: true,
        },
    )
    .unwrap();
    assert!(MessageRepository::get(&connection, "a", "m2")
        .unwrap()
        .is_none());
    assert_eq!(
        MessageRepository::draft_id(&connection, "a", "sent").unwrap(),
        None
    );
}

#[test]
fn a_newer_full_snapshot_removes_labels_the_message_lost_upstream() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "a".into(),
            email: "me@example.com".into(),
            display_name: "Me".into(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    let mut unread = message("m1", "t1");
    unread.label_ids = vec!["INBOX".into(), "UNREAD".into()];
    materialize::persist(&connection, "a", &unread).unwrap();

    let mut read = message("m1", "t1");
    read.history_id = 2;
    read.label_ids = vec!["INBOX".into()];
    materialize::persist(&connection, "a", &read).unwrap();

    assert_eq!(
        MessageRepository::label_ids(&connection, "a", "m1").unwrap(),
        vec!["INBOX".to_owned()]
    );
    assert!(
        !MessageRepository::get(&connection, "a", "m1")
            .unwrap()
            .unwrap()
            .is_unread
    );
}

#[test]
fn a_newer_full_snapshot_flags_the_labels_the_message_gained_upstream() {
    let connection = connection_with_account();
    let mut read = message("m1", "t1");
    read.label_ids = vec!["INBOX".into()];
    materialize::persist(&connection, "a", &read).unwrap();

    let mut unread_starred = message("m1", "t1");
    unread_starred.history_id = 2;
    unread_starred.label_ids = vec!["INBOX".into(), "STARRED".into(), "UNREAD".into()];
    materialize::persist(&connection, "a", &unread_starred).unwrap();

    let stored = MessageRepository::get(&connection, "a", "m1")
        .unwrap()
        .unwrap();
    assert!(stored.is_unread);
    assert!(stored.is_starred);
    assert_eq!(
        MessageRepository::label_ids(&connection, "a", "m1").unwrap(),
        vec![
            "INBOX".to_owned(),
            "STARRED".to_owned(),
            "UNREAD".to_owned()
        ]
    );
}
