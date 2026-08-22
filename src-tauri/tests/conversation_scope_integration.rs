use latentmail_lib::{
    search::scope::SearchScope,
    storage::{
        Account, AccountRepository, Attachment, AttachmentRepository, ConversationEntryScope,
        HtmlPresence, InlinePart, LabelRepository, Message, MessageRepository, Storage,
        ThreadRepository,
    },
};

fn seed_message(connection: &rusqlite::Connection, id: &str, labels: &[&str]) {
    MessageRepository::write_full_state(
        connection,
        &Message {
            account_id: "account".into(),
            id: id.into(),
            thread_id: "thread".into(),
            rfc_message_id: None,
            sender: "sender@example.com".into(),
            recipients: "recipient@example.com".into(),
            subject: "Subject".into(),
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
        },
    )
    .unwrap();
    for label in labels {
        LabelRepository::ensure_placeholder(connection, "account", label).unwrap();
        MessageRepository::set_label_membership(connection, "account", id, label, true).unwrap();
    }
}

fn seeded_connection() -> rusqlite::Connection {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "mail@example.com".into(),
            display_name: String::new(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    seed_message(&connection, "live", &["INBOX"]);
    seed_message(&connection, "trash", &["TRASH"]);
    seed_message(&connection, "spam", &["SPAM"]);
    ThreadRepository::recompute(&connection, "account", "thread").unwrap();
    connection
}

fn ids(connection: &rusqlite::Connection, scope: Option<&ConversationEntryScope>) -> Vec<String> {
    MessageRepository::list_conversation_metadata(connection, "account", "thread", scope)
        .unwrap()
        .into_iter()
        .map(|message| message.message.id)
        .collect()
}

#[test]
fn mailbox_scope_hides_trashed_and_spammed_messages_except_in_trash_and_spam() {
    let connection = seeded_connection();
    assert_eq!(
        ids(
            &connection,
            Some(&ConversationEntryScope::Mailbox {
                mailbox_id: "INBOX".into()
            })
        ),
        vec!["live"]
    );
    for mailbox_id in ["TRASH", "SPAM"] {
        assert_eq!(
            ids(
                &connection,
                Some(&ConversationEntryScope::Mailbox {
                    mailbox_id: mailbox_id.into()
                })
            ),
            vec!["live", "spam", "trash"]
        );
    }
}

#[test]
fn search_scope_includes_trashed_and_spammed_messages_only_when_explicit() {
    let connection = seeded_connection();
    for scope in [
        SearchScope::Default,
        SearchScope::Label {
            label_id: "INBOX".into(),
        },
    ] {
        assert_eq!(
            ids(&connection, Some(&ConversationEntryScope::Search { scope })),
            vec!["live"]
        );
    }
    for scope in [
        SearchScope::All,
        SearchScope::Label {
            label_id: "TRASH".into(),
        },
        SearchScope::Label {
            label_id: "SPAM".into(),
        },
    ] {
        assert_eq!(
            ids(&connection, Some(&ConversationEntryScope::Search { scope })),
            vec!["live", "spam", "trash"]
        );
    }
}

#[test]
fn ordinary_scope_returns_no_messages_when_every_message_is_trashed() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "mail@example.com".into(),
            display_name: String::new(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    seed_message(&connection, "trash", &["TRASH"]);
    ThreadRepository::recompute(&connection, "account", "thread").unwrap();
    assert!(ids(&connection, None).is_empty());
    assert_eq!(
        ids(
            &connection,
            Some(&ConversationEntryScope::Mailbox {
                mailbox_id: "TRASH".into()
            })
        ),
        vec!["trash"]
    );
}

#[test]
fn a_hidden_messages_labels_attachments_and_inline_parts_never_reach_a_visible_message() {
    let connection = seeded_connection();
    for hidden in ["trash", "spam"] {
        LabelRepository::ensure_placeholder(&connection, "account", "Label_hidden").unwrap();
        MessageRepository::set_label_membership(
            &connection,
            "account",
            hidden,
            "Label_hidden",
            true,
        )
        .unwrap();
        AttachmentRepository::replace_for_message(
            &connection,
            "account",
            hidden,
            &[Attachment {
                attachment_id: format!("{hidden}-attachment"),
                filename: "hidden.pdf".into(),
                mime_type: "application/pdf".into(),
                size: 1,
                position: 0,
            }],
        )
        .unwrap();
        MessageRepository::replace_inline_parts(
            &connection,
            "account",
            hidden,
            &[InlinePart {
                content_id: format!("{hidden}-cid"),
                mime_type: "image/png".into(),
                bytes: vec![1],
            }],
        )
        .unwrap();
    }

    let visible =
        MessageRepository::list_conversation_metadata(&connection, "account", "thread", None)
            .unwrap();

    assert_eq!(
        visible
            .iter()
            .map(|message| message.message.id.as_str())
            .collect::<Vec<_>>(),
        vec!["live"]
    );
    for message in &visible {
        assert!(!message
            .label_ids
            .iter()
            .any(|label| label == "Label_hidden"));
        assert!(message.attachments.is_empty());
        assert!(message.inline_content_ids.is_empty());
    }
}
