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
