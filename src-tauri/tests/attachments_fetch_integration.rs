use latentmail_lib::{attachments::cache::AttachmentCache, gmail::GmailClient};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

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
