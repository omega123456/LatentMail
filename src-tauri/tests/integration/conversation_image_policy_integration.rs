use crate::support::{account, app};
use latentmail_lib::ipc::{AppServices, CommandPayload};
use latentmail_lib::storage::{
    AccountRepository, ConversationEntryScope, HtmlPresence, LabelRepository, Message,
    MessageRepository, Storage, Thread, ThreadIdentity, ThreadRepository,
};
use latentmail_lib::storage::{LabelMembershipChange, MessageKey};
use latentmail_lib::sync::commands::load_message_body;
use latentmail_lib::sync::commands::LoadMessageBodyRequest;
use latentmail_lib::sync::ImagePolicy;
use tauri::Manager;

const REMOTE_IMAGE: &str = r#"<img src="https://tracker.example/pixel.png">"#;

fn seeded_storage(directory: &std::path::Path) -> Storage {
    let storage = Storage::open(directory.join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("account", "me@example.com", "Me")).unwrap();
    ThreadRepository::upsert(
        &connection,
        &Thread {
            account_id: "account".into(),
            id: "t1".into(),
            subject: "Newsletter".into(),
            participants: "Elena <Elena.R@Example.com>".into(),
            latest_at: 1,
            message_count: 2,
            is_unread: false,
            is_starred: false,
            has_attachments: false,
            has_draft: false,
            sender_identity: ThreadIdentity {
                display: "Elena".into(),
                address: Some("elena.r@example.com".into()),
            },
            recipient_identity: None,
        },
    )
    .unwrap();
    for (id, sender, label_id) in [
        ("m1", "Elena Rodriguez <Elena.R@Example.com>", "INBOX"),
        ("m2", "spammer@example.com", "SPAM"),
        ("m3", "Elena Rodriguez <Elena.R@Example.com>", "TRASH"),
    ] {
        MessageRepository::write_full_state(
            &connection,
            &Message {
                account_id: "account".into(),
                id: id.into(),
                thread_id: "t1".into(),
                rfc_message_id: None,
                sender: sender.into(),
                recipients: "me@example.com".into(),
                subject: "Newsletter".into(),
                sent_at: 1,
                snippet: String::new(),
                html_body: Some(REMOTE_IMAGE.into()),
                plain_body: None,
                has_attachments: false,
                is_unread: false,
                is_starred: false,
                history_id: 1,
                truncated_body: None,
                html_presence: HtmlPresence::Present,
            },
        )
        .unwrap();
        LabelRepository::ensure_placeholder(&connection, "account", label_id).unwrap();
        MessageRepository::set_label_membership(
            &connection,
            MessageKey {
                account_id: "account",
                message_id: id,
            },
            LabelMembershipChange {
                label_id: label_id,
                present: true,
            },
        )
        .unwrap();
    }
    ThreadRepository::recompute(&connection, "account", "t1").unwrap();
    drop(connection);
    storage
}

async fn conversation_under(
    storage: Storage,
    policy: Option<ImagePolicy>,
) -> Vec<(String, bool, bool, bool)> {
    let application = app();
    application.manage(storage);
    let mut messages = Vec::new();
    for message_id in ["m1", "m2", "m3"] {
        let message = load_message_body(
            AppServices::new(application.handle()),
            CommandPayload(LoadMessageBodyRequest {
                account_id: "account".into(),
                message_id: message_id.into(),
                image_policy: policy.clone(),
                entry_scope: Some(ConversationEntryScope::Mailbox {
                    mailbox_id: "SPAM".into(),
                }),
            }),
        )
        .await
        .unwrap();
        messages.push({
            (
                message_id.to_owned(),
                message.remote_images_allowed,
                message.remote_images_blocked,
                message
                    .html_body
                    .is_some_and(|html| html.contains("tracker.example")),
            )
        });
    }
    messages
}

#[tokio::test]
async fn no_policy_blocks_every_remote_image() {
    let directory = tempfile::tempdir().unwrap();
    let storage = seeded_storage(directory.path());

    assert_eq!(
        conversation_under(storage, None).await,
        vec![
            ("m1".to_owned(), false, true, false),
            ("m2".to_owned(), false, true, false),
            ("m3".to_owned(), false, true, false),
        ]
    );
}

#[tokio::test]
async fn always_load_allows_every_message_except_the_spammed_and_trashed_ones() {
    let directory = tempfile::tempdir().unwrap();
    let storage = seeded_storage(directory.path());

    assert_eq!(
        conversation_under(
            storage,
            Some(ImagePolicy {
                always_load: true,
                ..ImagePolicy::default()
            })
        )
        .await,
        vec![
            ("m1".to_owned(), true, false, true),
            ("m2".to_owned(), false, true, false),
            ("m3".to_owned(), false, true, false),
        ]
    );
}

#[tokio::test]
async fn a_trusted_sender_matches_the_header_address_case_insensitively() {
    let directory = tempfile::tempdir().unwrap();
    let storage = seeded_storage(directory.path());

    assert_eq!(
        conversation_under(
            storage,
            Some(ImagePolicy {
                allowed_senders: vec!["ELENA.R@example.COM".into()],
                ..ImagePolicy::default()
            })
        )
        .await,
        vec![
            ("m1".to_owned(), true, false, true),
            ("m2".to_owned(), false, true, false),
            ("m3".to_owned(), false, true, false),
        ]
    );
}

#[tokio::test]
async fn load_for_allows_only_the_named_message_and_never_a_spammed_or_trashed_one() {
    let directory = tempfile::tempdir().unwrap();
    let storage = seeded_storage(directory.path());

    assert_eq!(
        conversation_under(
            storage,
            Some(ImagePolicy {
                load_for: vec!["m1".into(), "m2".into(), "m3".into()],
                ..ImagePolicy::default()
            })
        )
        .await,
        vec![
            ("m1".to_owned(), true, false, true),
            ("m2".to_owned(), false, true, false),
            ("m3".to_owned(), false, true, false),
        ]
    );
}

#[tokio::test]
async fn a_trusted_sender_that_is_not_this_sender_changes_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let storage = seeded_storage(directory.path());

    assert_eq!(
        conversation_under(
            storage,
            Some(ImagePolicy {
                allowed_senders: vec!["someone.else@example.com".into()],
                ..ImagePolicy::default()
            })
        )
        .await,
        vec![
            ("m1".to_owned(), false, true, false),
            ("m2".to_owned(), false, true, false),
            ("m3".to_owned(), false, true, false),
        ]
    );
}
