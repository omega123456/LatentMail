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
    payload: Value,
}

#[tokio::test]
async fn committed_message_corpus_maps_payload_trees() {
    let shapes: Vec<Shape> =
        serde_json::from_str(include_str!("fixtures/gmail_payload_corpus.json")).unwrap();
    assert_eq!(shapes.len(), 8);
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
        if shape.name == "missing_headers" {
            assert!(message.sender.is_empty() && message.subject.is_empty());
        }
    }
}
