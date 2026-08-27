use latentmail_lib::{attachments::cache::AttachmentCache, gmail::GmailClient};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn record() -> latentmail_lib::storage::Attachment {
    latentmail_lib::storage::Attachment {
        attachment_id: "stale".into(),
        filename: "invoice.pdf".into(),
        mime_type: "application/pdf".into(),
        size: 5,
        position: 0,
    }
}

#[tokio::test]
async fn ensure_fetches_once_then_reuses_the_disk_cache_on_a_second_call() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1/attachments/a1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "data": "aGVsbG8" })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();
    let client = GmailClient::with_base_url("token", server.uri());

    let first = cache
        .ensure(&client, "account", "m1", "a1", "hello.txt", "text/plain")
        .await
        .unwrap();
    let second = cache
        .ensure(&client, "account", "m1", "a1", "hello.txt", "text/plain")
        .await
        .unwrap();

    assert_eq!(first.cache_path, second.cache_path);
    assert_eq!(std::fs::read(&second.cache_path).unwrap(), b"hello");

    server.verify().await;
}

#[tokio::test]
async fn attachment_bytes_larger_than_ten_megabytes_are_fetched_successfully() {
    let server = MockServer::start().await;
    let big = "a".repeat(15 * 1024 * 1024);
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1/attachments/big"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "data": big })))
        .mount(&server)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();
    let client = GmailClient::with_base_url("token", server.uri());

    let cached = cache
        .ensure(
            &client,
            "account",
            "m1",
            "big",
            "big.bin",
            "application/octet-stream",
        )
        .await
        .expect("an attachment past the old 10MB ceiling must still be fetchable");

    assert!(cached.size > 10 * 1024 * 1024);
}

#[tokio::test]
async fn refetch_downloads_under_the_stored_identifier_after_gmail_rotated_the_attachment_id() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "m1",
            "threadId": "t1",
            "historyId": "1",
            "payload": {
                "mimeType": "multipart/mixed",
                "parts": [
                    { "mimeType": "text/plain", "body": { "data": "Ym9keQ" } },
                    {
                        "mimeType": "application/pdf",
                        "filename": "invoice.pdf",
                        "body": { "attachmentId": "rotated", "size": 5 }
                    }
                ]
            }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1/attachments/rotated"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "data": "aGVsbG8" })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();
    let client = GmailClient::with_base_url("token", server.uri());
    let cached = latentmail_lib::attachments::refetch(&cache, &client, "account", "m1", &record())
        .await
        .unwrap();

    assert_eq!(std::fs::read(&cached.cache_path).unwrap(), b"hello");
    assert_eq!(
        cache
            .lookup("account", "m1", "stale", "invoice.pdf", "application/pdf")
            .map(|entry| entry.cache_path),
        Some(cached.cache_path),
        "the bytes must land under the identifier the reader already holds"
    );
    server.verify().await;
}

#[tokio::test]
async fn refetch_reports_an_attachment_that_the_message_no_longer_carries() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "m1",
            "threadId": "t1",
            "historyId": "1",
            "payload": { "mimeType": "text/plain", "body": { "data": "Ym9keQ" } }
        })))
        .mount(&server)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();
    let client = GmailClient::with_base_url("token", server.uri());

    let error = latentmail_lib::attachments::refetch(&cache, &client, "account", "m1", &record())
        .await
        .unwrap_err();

    assert_eq!(error, "Attachment is no longer part of this message");
}

#[tokio::test]
async fn refetch_surfaces_the_error_when_the_message_is_gone() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();
    let client = GmailClient::with_base_url("token", server.uri());

    assert!(
        latentmail_lib::attachments::refetch(&cache, &client, "account", "m1", &record())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn refetch_surfaces_the_error_when_the_rotated_attachment_is_gone() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "m1",
            "threadId": "t1",
            "historyId": "1",
            "payload": {
                "mimeType": "multipart/mixed",
                "parts": [
                    { "mimeType": "text/plain", "body": { "data": "Ym9keQ" } },
                    {
                        "mimeType": "application/pdf",
                        "filename": "invoice.pdf",
                        "body": { "attachmentId": "rotated", "size": 5 }
                    }
                ]
            }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1/attachments/rotated"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();
    let client = GmailClient::with_base_url("token", server.uri());

    assert!(
        latentmail_lib::attachments::refetch(&cache, &client, "account", "m1", &record())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn refetch_writes_inline_part_bytes_without_a_second_request() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "m1",
            "threadId": "t1",
            "historyId": "1",
            "payload": {
                "mimeType": "multipart/mixed",
                "parts": [
                    { "mimeType": "text/plain", "body": { "data": "Ym9keQ" } },
                    {
                        "mimeType": "application/pdf",
                        "filename": "invoice.pdf",
                        "body": { "data": "aGVsbG8" }
                    }
                ]
            }
        })))
        .mount(&server)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let cache = AttachmentCache::new(directory.path().join("cache")).unwrap();
    let client = GmailClient::with_base_url("token", server.uri());

    let cached = latentmail_lib::attachments::refetch(&cache, &client, "account", "m1", &record())
        .await
        .unwrap();

    assert_eq!(std::fs::read(&cached.cache_path).unwrap(), b"hello");
}
