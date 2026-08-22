use latentmail_lib::{
    attachments::cache::AttachmentCache,
    gmail::{AttachmentPart, GmailMessage},
    storage::{Account, AccountRepository, AttachmentRepository, MessageRepository, Storage},
    sync::{materialize, noop_event_sink, traversal::run_backfill_step},
};

fn account() -> Account {
    Account {
        id: "account".into(),
        email: "me@example.com".into(),
        display_name: "Me".into(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}

fn base_message(id: &str, history_id: i64) -> GmailMessage {
    GmailMessage {
        id: id.into(),
        thread_id: "thread".into(),
        history_id,
        label_ids: Vec::new(),
        snippet: String::new(),
        sent_at: 1,
        rfc_message_id: None,
        sender: "sender@example.com".into(),
        recipients: "to@example.com".into(),
        to_recipients: "to@example.com".into(),
        cc_recipients: String::new(),
        bcc_recipients: String::new(),
        rfc_references: None,
        subject: "Subject".into(),
        html_body: None,
        plain_body: Some("body".into()),
        has_attachments: true,
        inline_parts: Vec::new(),
        attachment_parts: vec![AttachmentPart {
            attachment_id: "att-1".into(),
            content_id: None,
            filename: "file.pdf".into(),
            mime_type: "application/pdf".into(),
            size: 1024,
            inline_bytes: None,
        }],
        oversize: false,
    }
}

#[test]
fn materialize_persists_attachment_rows_in_sender_order() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();

    let mut message = base_message("m1", 1);
    message.attachment_parts.push(AttachmentPart {
        attachment_id: "att-2".into(),
        content_id: None,
        filename: "second.txt".into(),
        mime_type: "text/plain".into(),
        size: 12,
        inline_bytes: None,
    });
    materialize::persist(&connection, "account", &message).unwrap();

    let rows = AttachmentRepository::for_message(&connection, "account", "m1").unwrap();
    assert_eq!(
        rows.iter()
            .map(|row| row.attachment_id.as_str())
            .collect::<Vec<_>>(),
        vec!["att-1", "att-2"]
    );
    assert_eq!(rows[0].filename, "file.pdf");
    assert_eq!(rows[0].size, 1024);
}

#[test]
fn deleting_a_message_cascades_its_attachment_rows() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    materialize::persist(&connection, "account", &base_message("m1", 1)).unwrap();
    assert_eq!(
        AttachmentRepository::for_message(&connection, "account", "m1")
            .unwrap()
            .len(),
        1
    );

    MessageRepository::delete(&connection, "account", "m1").unwrap();

    assert!(
        AttachmentRepository::for_message(&connection, "account", "m1")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn an_existing_message_acquires_attachment_rows_on_its_next_sync_even_though_the_message_row_is_unchanged(
) {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();

    let mut without_attachments = base_message("m1", 5);
    without_attachments.attachment_parts.clear();
    without_attachments.has_attachments = false;
    materialize::persist(&connection, "account", &without_attachments).unwrap();
    assert!(
        AttachmentRepository::for_message(&connection, "account", "m1")
            .unwrap()
            .is_empty()
    );

    let same_history_but_with_attachments = base_message("m1", 5);
    materialize::persist(&connection, "account", &same_history_but_with_attachments).unwrap();

    let rows = AttachmentRepository::for_message(&connection, "account", "m1").unwrap();
    assert_eq!(
        rows.len(),
        1,
        "attachment rows must be written even when the message row's history_id guard skips the message update"
    );
}

#[tokio::test]
async fn backfill_traversal_writes_attachment_rows_for_a_never_body_fetched_message() {
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path("/users/me/profile"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "emailAddress": "me@example.com",
                "messagesTotal": 1,
                "threadsTotal": 1,
                "historyId": "1"
            })),
        )
        .mount(&server)
        .await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path("/users/me/messages"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "messages": [{ "id": "m1", "threadId": "t1" }]
            })),
        )
        .mount(&server)
        .await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path("/users/me/messages/m1"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "m1",
                "threadId": "t1",
                "historyId": "1",
                "payload": {
                    "mimeType": "multipart/mixed",
                    "parts": [
                        { "mimeType": "text/plain", "body": { "data": "Ym9keQ" } },
                        {
                            "mimeType": "application/pdf",
                            "filename": "report.pdf",
                            "body": { "attachmentId": "gmail-att-1", "size": 2048 }
                        }
                    ]
                }
            })),
        )
        .mount(&server)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    drop(connection);

    let client = latentmail_lib::gmail::GmailClient::with_base_url("token", server.uri());
    run_backfill_step(
        &storage,
        &client,
        "account",
        &noop_event_sink(),
        false,
        None,
    )
    .await
    .unwrap();

    let connection = storage.connection().unwrap();
    let rows = AttachmentRepository::for_message(&connection, "account", "m1").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].attachment_id, "gmail-att-1");
    assert_eq!(rows[0].filename, "report.pdf");
    assert_eq!(rows[0].size, 2048);
}

#[tokio::test]
async fn backfill_seeds_cache_bytes_for_an_inline_data_attachment_with_no_interactive_fetch() {
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path("/users/me/profile"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "emailAddress": "me@example.com",
                "messagesTotal": 1,
                "threadsTotal": 1,
                "historyId": "1"
            })),
        )
        .mount(&server)
        .await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path("/users/me/messages"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "messages": [{ "id": "m1", "threadId": "t1" }]
            })),
        )
        .mount(&server)
        .await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path("/users/me/messages/m1"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "m1",
                "threadId": "t1",
                "historyId": "1",
                "payload": {
                    "mimeType": "multipart/mixed",
                    "parts": [
                        { "mimeType": "text/plain", "body": { "data": "Ym9keQ" } },
                        {
                            "mimeType": "image/jpeg",
                            "filename": "photo.jpg",
                            "body": { "data": "cGhvdG8" }
                        }
                    ]
                }
            })),
        )
        .mount(&server)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();
    drop(connection);

    let cache_dir = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(cache_dir.path()).unwrap();

    let client = latentmail_lib::gmail::GmailClient::with_base_url("token", server.uri());
    run_backfill_step(
        &storage,
        &client,
        "account",
        &noop_event_sink(),
        false,
        Some(cache.clone()),
    )
    .await
    .unwrap();

    let connection = storage.connection().unwrap();
    let rows = AttachmentRepository::for_message(&connection, "account", "m1").unwrap();
    assert_eq!(rows.len(), 1);
    assert!(
        rows[0].attachment_id.starts_with("latentmail-inline-"),
        "the row must carry the synthesised, reserved-prefix identifier: {}",
        rows[0].attachment_id
    );

    let cached = cache.lookup(
        "account",
        "m1",
        &rows[0].attachment_id,
        &rows[0].filename,
        &rows[0].mime_type,
    );
    assert!(
        cached.is_some(),
        "backfill alone, with no interactive body fetch, must seed cache bytes for a D15-recovered attachment"
    );
    assert_eq!(cached.unwrap().size, "photo".len() as u64);
}

#[test]
fn list_conversation_attributes_attachments_to_the_right_message_sorted_by_position() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(&connection, &account()).unwrap();

    let mut first = base_message("m1", 1);
    first.attachment_parts = vec![
        AttachmentPart {
            attachment_id: "att-b".into(),
            content_id: None,
            filename: "b.txt".into(),
            mime_type: "text/plain".into(),
            size: 20,
            inline_bytes: None,
        },
        AttachmentPart {
            attachment_id: "att-a".into(),
            content_id: None,
            filename: "a.txt".into(),
            mime_type: "text/plain".into(),
            size: 10,
            inline_bytes: None,
        },
    ];
    materialize::persist(&connection, "account", &first).unwrap();

    let mut second = base_message("m2", 1);
    second.attachment_parts.clear();
    second.has_attachments = false;
    materialize::persist(&connection, "account", &second).unwrap();

    let messages =
        MessageRepository::list_conversation(&connection, "account", "thread", None).unwrap();
    assert_eq!(messages.len(), 2);
    let by_id: std::collections::HashMap<_, _> = messages
        .into_iter()
        .map(|value| (value.message.id.clone(), value))
        .collect();

    let first_attachments = &by_id["m1"].attachments;
    assert_eq!(
        first_attachments
            .iter()
            .map(|attachment| attachment.attachment_id.as_str())
            .collect::<Vec<_>>(),
        vec!["att-b", "att-a"],
        "rows must stay sorted by their sender-order position"
    );
    assert_eq!(first_attachments[0].filename, "b.txt");
    assert_eq!(first_attachments[0].size, 20);

    assert!(
        by_id["m2"].attachments.is_empty(),
        "a message with no attachments must not inherit another message's rows"
    );
}
