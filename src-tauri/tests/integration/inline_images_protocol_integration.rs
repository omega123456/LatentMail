use latentmail_lib::inline_images::{proxy_url, respond, target, SCHEME};
use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, InlinePart, Message, MessageRepository, Storage,
};

fn storage_with_one_inline_part() -> (tempfile::TempDir, Storage) {
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
    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: "account".into(),
            id: "message".into(),
            thread_id: "thread".into(),
            rfc_message_id: None,
            sender: "sender@example.com".into(),
            recipients: String::new(),
            subject: "Subject".into(),
            sent_at: 1,
            snippet: "snippet".into(),
            html_body: Some(r#"<img src="cid:logo@example.com">"#.into()),
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
    MessageRepository::replace_inline_parts(
        &connection,
        "account",
        "message",
        &[InlinePart {
            content_id: "logo@example.com".into(),
            mime_type: "image/jpeg".into(),
            bytes: vec![7, 8, 9],
        }],
    )
    .unwrap();
    drop(connection);
    (directory, storage)
}

#[test]
fn builds_a_proxy_url_that_carries_the_account_message_and_content_id() {
    let url = proxy_url("account", "message", "logo@example.com");

    assert!(url.contains(SCHEME), "{url}");
    assert_eq!(
        target(&url),
        Some((
            "account".to_owned(),
            "message".to_owned(),
            "logo@example.com".to_owned()
        ))
    );
}

#[test]
fn refuses_a_request_that_names_no_inline_part() {
    assert!(target("inlineimg://localhost/?account=a&message=b").is_none());
    assert!(target("inlineimg://localhost/?cid=logo").is_none());
    assert!(target("not a url").is_none());
}

#[tokio::test]
async fn serves_a_stored_inline_part_from_the_application_origin() {
    let (_directory, storage) = storage_with_one_inline_part();

    let response = respond(
        &storage,
        &proxy_url("account", "message", "logo@example.com"),
    )
    .await;

    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "image/jpeg"
    );
    assert_eq!(response.body(), &vec![7, 8, 9]);
}

#[tokio::test]
async fn refuses_a_content_id_the_message_does_not_carry() {
    let (_directory, storage) = storage_with_one_inline_part();

    let response = respond(&storage, &proxy_url("account", "message", "other")).await;

    assert_eq!(response.status(), 404);
    assert!(response.body().is_empty());
}

#[tokio::test]
async fn refuses_an_inline_part_belonging_to_another_account() {
    let (_directory, storage) = storage_with_one_inline_part();

    let response = respond(
        &storage,
        &proxy_url("other-account", "message", "logo@example.com"),
    )
    .await;

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn refuses_a_malformed_request() {
    let (_directory, storage) = storage_with_one_inline_part();

    let response = respond(&storage, "inlineimg://localhost/?cid=logo").await;

    assert_eq!(response.status(), 404);
}
