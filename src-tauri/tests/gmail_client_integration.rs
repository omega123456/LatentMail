use latentmail_lib::gmail::GmailClient;
use wiremock::{
    matchers::{body_json, method, path, query_param},
    Mock, MockServer, ResponseTemplate,
};

#[tokio::test]
async fn client_round_trips_every_slice_endpoint_and_paginates() {
    let server = MockServer::start().await;
    let client = GmailClient::with_base_url("token", server.uri());
    Mock::given(method("GET")).and(path("/users/me/profile")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"emailAddress":"me@example.com","messagesTotal":3,"threadsTotal":2,"historyId":"9"}))).mount(&server).await;
    Mock::given(method("GET")).and(path("/users/me/labels")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels":[{"id":"INBOX","name":"Inbox","type":"system","messagesTotal":3,"messagesUnread":1}]}))).mount(&server).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .and(query_param("pageToken", "next"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"messages":[{"id":"b","threadId":"t"}]})),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"messages":[{"id":"a","threadId":"t"}],"nextPageToken":"next"}),
        ))
        .mount(&server)
        .await;
    let message = serde_json::json!({"id":"a","threadId":"t","historyId":"10","labelIds":["INBOX"],"snippet":"hello","internalDate":"1000","payload":{"mimeType":"text/plain","headers":[{"name":"From","value":"Sender <s@example.com>"},{"name":"To","value":"me@example.com"},{"name":"Subject","value":"Hi"}],"body":{"data":"aGVsbG8"}}});
    Mock::given(method("GET")).and(path("/users/me/messages/a")).and(query_param("fields", "id,threadId,historyId,labelIds,snippet,internalDate,payload(headers,body,parts,filename,mimeType,partId)")).respond_with(ResponseTemplate::new(200).set_body_json(message.clone())).mount(&server).await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/a/modify"))
        .and(body_json(
            serde_json::json!({"addLabelIds":["STARRED"],"removeLabelIds":[]}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(message))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;
    Mock::given(method("GET")).and(path("/users/me/history")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"historyId":"11","history":[{"id":"11","messagesAdded":[{"message":{"id":"a","threadId":"t"}}]}]}))).mount(&server).await;

    assert_eq!(
        client.profile().await.unwrap().email_address,
        "me@example.com"
    );
    assert_eq!(client.labels().await.unwrap()[0].id, "INBOX");
    assert_eq!(
        client
            .list_all_messages(&["INBOX".into()])
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        client.message("a").await.unwrap().plain_body.as_deref(),
        Some("hello")
    );
    assert_eq!(
        client
            .modify_message("a", &["STARRED".into()], &[])
            .await
            .unwrap()
            .history_id,
        10
    );
    client
        .batch_modify(&["a".into()], &[], &["UNREAD".into()])
        .await
        .unwrap();
    assert_eq!(
        client.history_page(9, None).await.unwrap().records[0].messages_added[0].id,
        "a"
    );
}

#[tokio::test]
async fn draft_uploads_use_upload_base_while_attachment_hydration_uses_standard_base() {
    let server = MockServer::start().await;
    let draft = serde_json::json!({"id":"d1","message":{"id":"m1","threadId":"t1","labelIds":["DRAFT"]}});
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/messages/m1/attachments/a1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"data":"aGVsbG8"})),
        )
        .mount(&server)
        .await;
    let client = GmailClient::with_base_url("token", format!("{}/gmail/v1", server.uri()));
    assert_eq!(client.create_draft(b"hello", Some("t1")).await.unwrap(), "d1");
    assert_eq!(client.attachment("m1", "a1").await.unwrap(), b"hello");
}

/// A bounce the sending host queued overnight: Gmail accepted it on Jul 23,
/// but `internalDate` carries the sender's Jul 22 `Date:` instead. Gmail's own
/// list shows the receipt time, so the topmost `Received:` hop wins. Values are
/// the real ones observed against the live API.
#[tokio::test]
async fn message_dates_from_the_received_hop_when_internal_date_lags_behind() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/a"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "a", "threadId": "t", "historyId": "10", "labelIds": ["INBOX"],
            "snippet": "hello", "internalDate": "1784747859000",
            "payload": { "headers": [
                { "name": "Received", "value": "by 2002:a05:0000:0000:b0:123::with SMTP id x1csp1;\r\n        Thu, 23 Jul 2026 03:37:39 -0700 (PDT)" },
                { "name": "Received", "value": "from raspberrypi.local (host.example) by mx.google.com;\r\n        Wed, 22 Jul 2026 12:17:40 -0700 (PDT)" },
                { "name": "Date", "value": "Wed, 22 Jul 2026 20:17:39 +0100 (BST)" }
            ] }
        })))
        .mount(&server)
        .await;

    let message = GmailClient::with_base_url("token", server.uri())
        .message("a")
        .await
        .unwrap();

    assert_eq!(message.sent_at, 1_784_803_059);
}

/// Without a `Received:` hop to read, `internalDate` still beats a divergent
/// `Date:` header.
#[tokio::test]
async fn message_prefers_internal_date_over_a_divergent_date_header() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/a"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "a", "threadId": "t", "historyId": "10", "labelIds": ["INBOX"],
            "snippet": "hello", "internalDate": "1753267059743",
            "payload": { "headers": [{ "name": "Date", "value": "Wed, 22 Jul 2026 19:17:39 +0000" }] }
        })))
        .mount(&server)
        .await;

    let message = GmailClient::with_base_url("token", server.uri())
        .message("a")
        .await
        .unwrap();

    assert_eq!(message.sent_at, 1_753_267_059);
}
