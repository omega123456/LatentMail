use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, LabelRepository, Message, MessageRepository, Storage,
    Thread, ThreadIdentity, ThreadRepository,
};
use latentmail_lib::sync::commands::load_conversation;
use latentmail_lib::sync::ImagePolicy;
use tauri::Manager;

const REMOTE_IMAGE: &str = r#"<img src="https://tracker.example/pixel.png">"#;

fn app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

fn seeded_storage(directory: &std::path::Path) -> Storage {
    let storage = Storage::open(directory.join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "me@example.com".into(),
            display_name: "Me".into(),
            history_id: None,
            avatar_url: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
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
        MessageRepository::set_label_membership(&connection, "account", id, label_id, true).unwrap();
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
    load_conversation(application.state(), "account".into(), "t1".into(), policy)
        .await
        .unwrap()
        .messages
        .into_iter()
        .map(|message| {
            (
                message.id,
                message.remote_images_allowed,
                message.remote_images_blocked,
                message
                    .html_body
                    .is_some_and(|html| html.contains("tracker.example")),
            )
        })
        .collect()
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
        ]
    );
}

#[tokio::test]
async fn always_load_allows_every_message_except_the_spammed_one() {
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
        ]
    );
}

#[tokio::test]
async fn load_for_allows_only_the_named_message_and_never_a_spammed_one() {
    let directory = tempfile::tempdir().unwrap();
    let storage = seeded_storage(directory.path());

    assert_eq!(
        conversation_under(
            storage,
            Some(ImagePolicy {
                load_for: vec!["m1".into(), "m2".into()],
                ..ImagePolicy::default()
            })
        )
        .await,
        vec![
            ("m1".to_owned(), true, false, true),
            ("m2".to_owned(), false, true, false),
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
        ]
    );
}
