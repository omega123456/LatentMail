use latentmail_lib::gmail::GmailClient;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

async fn fetch(payload: serde_json::Value) -> latentmail_lib::gmail::GmailMessage {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "id": "m1",
        "threadId": "t1",
        "historyId": "7",
        "payload": payload
    });
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;
    GmailClient::with_base_url("token", server.uri())
        .message("m1")
        .await
        .unwrap()
}

#[tokio::test]
async fn a_cid_referenced_part_held_locally_produces_no_attachment_row() {
    let message = fetch(serde_json::json!({
        "mimeType": "multipart/related",
        "parts": [
            { "mimeType": "text/html", "body": { "data": "PGltZyBzcmM9ImNpZDppbWFnZUBjaWQiPg" } },
            {
                "mimeType": "image/png",
                "headers": [{ "name": "Content-ID", "value": "<image@cid>" }],
                "body": { "data": "aW1n" }
            }
        ]
    }))
    .await;

    assert!(message.attachment_parts.is_empty());
    assert!(!message.has_attachments);
    assert_eq!(message.inline_parts.len(), 1);
}

#[tokio::test]
async fn a_filename_only_part_with_no_content_id_produces_one_row() {
    let message = fetch(serde_json::json!({
        "mimeType": "multipart/mixed",
        "parts": [
            { "mimeType": "text/plain", "body": { "data": "Ym9keQ" } },
            {
                "mimeType": "application/pdf",
                "filename": "file.pdf",
                "body": { "attachmentId": "gmail-att-1", "size": 4096 }
            }
        ]
    }))
    .await;

    assert_eq!(message.attachment_parts.len(), 1);
    assert!(message.has_attachments);
    let attachment = &message.attachment_parts[0];
    assert_eq!(attachment.attachment_id, "gmail-att-1");
    assert_eq!(attachment.filename, "file.pdf");
    assert_eq!(attachment.size, 4096);
    assert!(attachment.inline_bytes.is_none());
}

#[tokio::test]
async fn a_cid_referenced_part_that_arrived_by_reference_produces_one_row() {
    let message = fetch(serde_json::json!({
        "mimeType": "multipart/related",
        "parts": [
            { "mimeType": "text/html", "body": { "data": "PGltZyBzcmM9ImNpZDppbWFnZUBjaWQiPg" } },
            {
                "mimeType": "image/png",
                "headers": [{ "name": "Content-ID", "value": "<image@cid>" }],
                "body": { "attachmentId": "gmail-att-2", "size": 999 }
            }
        ]
    }))
    .await;

    assert_eq!(message.attachment_parts.len(), 1);
    assert!(message.has_attachments);
    assert_eq!(message.attachment_parts[0].attachment_id, "gmail-att-2");
    assert_eq!(
        message.attachment_parts[0].content_id.as_deref(),
        Some("image@cid")
    );
    assert!(message.inline_parts.is_empty());
}

#[tokio::test]
async fn has_attachments_is_false_when_only_inline_images_are_present() {
    let message = fetch(serde_json::json!({
        "mimeType": "multipart/related",
        "parts": [
            { "mimeType": "text/html", "body": { "data": "PGltZyBzcmM9ImNpZDppbWFnZUBjaWQiPg" } },
            {
                "mimeType": "image/png",
                "headers": [{ "name": "Content-ID", "value": "<image@cid>" }],
                "body": { "data": "aW1n" }
            }
        ]
    }))
    .await;

    assert!(!message.has_attachments);
}

#[tokio::test]
async fn an_inline_data_part_with_no_attachment_id_is_recovered_under_the_reserved_prefix() {
    let message = fetch(serde_json::json!({
        "mimeType": "multipart/mixed",
        "parts": [
            { "mimeType": "text/plain", "body": { "data": "Ym9keQ" } },
            {
                "mimeType": "image/jpeg",
                "filename": "photo.jpg",
                "body": { "data": "cGhvdG8" }
            }
        ]
    }))
    .await;

    assert_eq!(message.attachment_parts.len(), 1);
    let attachment = &message.attachment_parts[0];
    assert!(
        attachment.attachment_id.starts_with("latentmail-inline-"),
        "synthesised id must live under the reserved prefix: {}",
        attachment.attachment_id
    );
    assert_eq!(attachment.filename, "photo.jpg");
    assert!(attachment.inline_bytes.is_some());
}
