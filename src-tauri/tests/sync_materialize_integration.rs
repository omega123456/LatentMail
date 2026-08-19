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

#[test]
fn draft_replacement_tracks_the_stable_draft_id_across_gmail_message_ids() {
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

    materialize::replace_draft(&connection, "a", "d1", &message("m1", "t1"), false).unwrap();
    materialize::replace_draft(&connection, "a", "d1", &message("m2", "t2"), false).unwrap();

    assert!(MessageRepository::get(&connection, "a", "m1")
        .unwrap()
        .is_none());
    assert_eq!(
        MessageRepository::draft_id(&connection, "a", "m2")
            .unwrap()
            .as_deref(),
        Some("d1")
    );
    materialize::replace_draft(&connection, "a", "d1", &message("sent", "t2"), true).unwrap();
    assert!(MessageRepository::get(&connection, "a", "m2")
        .unwrap()
        .is_none());
    assert_eq!(
        MessageRepository::draft_id(&connection, "a", "sent").unwrap(),
        None
    );
}
