use latentmail_lib::gmail::GmailClient;
use serde::Deserialize;
use serde_json::Value;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Shape {
    name: String,
    expect_plain: Option<String>,
    expect_html: Option<String>,
    attachment: Option<bool>,
    inline: Option<String>,
    expect_inline_mime: Option<String>,
    payload: Value,
}

#[tokio::test]
async fn committed_message_corpus_maps_payload_trees() {
    let shapes: Vec<Shape> =
        serde_json::from_str(include_str!("fixtures/gmail_payload_corpus.json")).unwrap();
    assert_eq!(shapes.len(), 9);
    for shape in shapes {
        let server = MockServer::start().await;
        let body = serde_json::json!({"id":shape.name,"threadId":"thread","historyId":"7","payload":shape.payload});
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{}", shape.name)))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        let message = GmailClient::with_base_url("token", server.uri())
            .message(&shape.name)
            .await
            .unwrap();
        assert_eq!(
            message.plain_body.as_deref(),
            shape.expect_plain.as_deref(),
            "{}",
            shape.name
        );
        assert_eq!(
            message.html_body.as_deref(),
            shape.expect_html.as_deref(),
            "{}",
            shape.name
        );
        assert_eq!(
            message.has_attachments,
            shape.attachment.unwrap_or(false),
            "{}",
            shape.name
        );
        if let Some(cid) = shape.inline {
            assert_eq!(message.inline_parts[0].content_id, cid);
        }

        if let Some(expected) = shape.expect_inline_mime {
            assert_eq!(message.inline_parts[0].mime_type, expected, "{}", shape.name);
        }
        if shape.name == "missing_headers" {
            assert!(message.sender.is_empty() && message.subject.is_empty());
        }
    }
}

#[tokio::test]
async fn default_client_constructor_and_page_wrapper_map_server_data() {
    drop(GmailClient::new("token"));
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{ "id": "m1", "threadId": "t1" }]
        })))
        .mount(&server)
        .await;

    let page = GmailClient::with_base_url("token", server.uri())
        .list_messages_page(&[], None)
        .await
        .unwrap();

    assert_eq!(page.items[0].id, "m1");
}

#[tokio::test]
async fn message_date_header_is_used_when_internal_date_is_missing() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/dated"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "dated",
            "threadId": "thread",
            "historyId": "7",
            "payload": {
                "headers": [{ "name": "Date", "value": "Tue, 12 Aug 2025 10:00:00 +0000" }]
            }
        })))
        .mount(&server)
        .await;

    let message = GmailClient::with_base_url("token", server.uri())
        .message("dated")
        .await
        .unwrap();

    assert_eq!(
        message.sent_at,
        chrono::DateTime::parse_from_rfc2822("Tue, 12 Aug 2025 10:00:00 +0000")
            .unwrap()
            .timestamp()
    );
}

#[tokio::test]
async fn message_snippet_html_entities_are_decoded() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/entities"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "entities",
            "threadId": "thread",
            "historyId": "7",
            "snippet": "I&#39;m sorry &amp; you &lt;3 &quot;this&quot; &gt; that",
            "payload": {}
        })))
        .mount(&server)
        .await;

    let message = GmailClient::with_base_url("token", server.uri())
        .message("entities")
        .await
        .unwrap();

    assert_eq!(message.snippet, "I'm sorry & you <3 \"this\" > that");
}
