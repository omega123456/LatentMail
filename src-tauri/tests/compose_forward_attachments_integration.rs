use latentmail_lib::{
    storage::{
        Account, AccountRepository, Attachment, AttachmentRepository, HtmlPresence, Message,
        MessageRepository, Storage,
    },
    sync::commands::reply_context,
};
use tauri::Manager;

fn account() -> Account {
    Account {
        id: "account".into(),
        email: "me@example.com".into(),
        display_name: String::new(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}

fn original_message() -> Message {
    Message {
        account_id: "account".into(),
        id: "original".into(),
        thread_id: "thread-original".into(),
        rfc_message_id: Some("<original@example.com>".into()),
        sender: "sender@example.com".into(),
        recipients: "me@example.com".into(),
        subject: "Report".into(),
        sent_at: 1,
        snippet: "report".into(),
        html_body: Some("<p>Report</p>".into()),
        plain_body: None,
        has_attachments: true,
        is_unread: false,
        is_starred: false,
        history_id: 1,
        truncated_body: None,
        html_presence: HtmlPresence::Present,
    }
}

#[tokio::test]
async fn forward_reply_context_returns_persisted_attachment_metadata_without_contacting_gmail() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    MessageRepository::write_full_state(&connection, &original_message()).unwrap();
    AttachmentRepository::replace_for_message(
        &connection,
        "account",
        "original",
        &[Attachment {
            attachment_id: "att-1".into(),
            filename: "report.pdf".into(),
            mime_type: "application/pdf".into(),
            size: 1024,
            position: 0,
        }],
    )
    .unwrap();
    drop(connection);

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(storage);

    let context = reply_context(
        app.state(),
        "account".into(),
        "original".into(),
        "me@example.com".into(),
        false,
        true,
        "owner".into(),
    )
    .await
    .unwrap();

    assert_eq!(context.attachments.len(), 1);
    assert_eq!(context.attachments[0].id, "att-1");
    assert_eq!(context.attachments[0].filename, "report.pdf");
    assert_eq!(context.attachments[0].mime_type, "application/pdf");
    assert_eq!(context.attachments[0].size, 1024);
}
