use latentmail_lib::gmail::GmailClient;
use wiremock::{
    matchers::{body_json, method, path, query_param},
    Mock, MockServer, ResponseTemplate,
};

fn draft(id: &str, message: &str) -> serde_json::Value {
    serde_json::json!({"id": id, "message": {"id": message, "threadId": "t", "historyId": "1", "payload": {"headers": []}}})
}

/// What Gmail actually answers a draft write with: no `historyId`, no
/// `payload`. Every write mock below uses this rather than a full draft, so
/// a client that insists on the complete message fails here instead of in
/// production.
fn written_draft(id: &str, message: &str) -> serde_json::Value {
    serde_json::json!({"id": id, "message": {"id": message, "threadId": "t", "labelIds": ["DRAFT"]}})
}

#[tokio::test]
async fn draft_lifecycle_uses_upload_for_writes_and_standard_routes_for_read_and_send() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(written_draft("d", "m1")))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/upload/gmail/v1/users/me/drafts/d"))
        .respond_with(ResponseTemplate::new(200).set_body_json(written_draft("d", "m2")))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/drafts/d"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft("d", "m2")))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/gmail/v1/users/me/drafts/send"))
        .and(body_json(serde_json::json!({"id": "d"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"id": "sent", "threadId": "t", "labelIds": ["SENT"]}),
        ))
        .mount(&server)
        .await;
    let client = GmailClient::with_base_url("token", format!("{}/gmail/v1", server.uri()));
    assert_eq!(client.create_draft(b"raw", Some("t")).await.unwrap(), "d");
    assert_eq!(
        client.update_draft("d", b"raw", Some("t")).await.unwrap(),
        "d"
    );
    // Only the full read carries a message — that is where the body a
    // caller can materialize comes from.
    let full = client.draft("d").await.unwrap();
    assert_eq!((full.id.as_str(), full.message.id.as_str()), ("d", "m2"));
    assert_eq!(client.send_draft("d").await.unwrap(), "sent");
}

/// Gmail's upload endpoints reject anything that is not a `multipart/related`
/// document with an `uploadType` — a plain JSON body carrying `raw`/`threadId`
/// at the top level is answered 400 before the message is looked at, which is
/// what made every send silently fail.
#[tokio::test]
async fn draft_upload_posts_a_multipart_related_document_with_an_upload_type() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .and(query_param("uploadType", "multipart"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft("d", "m1")))
        .mount(&server)
        .await;
    let client = GmailClient::with_base_url("token", format!("{}/gmail/v1", server.uri()));
    client
        .create_draft(b"From: me@example.com\r\n\r\nbody", Some("t"))
        .await
        .unwrap();

    let requests = server.received_requests().await.unwrap();
    let request = requests.first().expect("the upload request was recorded");
    let content_type = request
        .headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let boundary = content_type
        .strip_prefix("multipart/related; boundary=")
        .expect("related content type carries the body's boundary");
    let body = String::from_utf8(request.body.clone()).unwrap();
    assert!(
        body.starts_with(&format!(
            "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{{\"message\":{{\"threadId\":\"t\"}}}}\r\n"
        )),
        "the Draft resource is the first part: {body}"
    );
    assert!(
        body.contains("Content-Type: message/rfc822\r\n\r\nFrom: me@example.com\r\n\r\nbody\r\n"),
        "the RFC822 document is the second part, verbatim: {body}"
    );
    assert!(body.ends_with(&format!("--{boundary}--\r\n")));
}

#[tokio::test]
async fn a_rejected_draft_upload_surfaces_its_status() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(ResponseTemplate::new(400).set_body_string("Invalid JSON payload"))
        .mount(&server)
        .await;
    let client = GmailClient::with_base_url("token", format!("{}/gmail/v1", server.uri()));
    assert!(matches!(
        client.create_draft(b"raw", None).await,
        Err(latentmail_lib::gmail::GmailError::Http(400))
    ));
}
