use latentmail_lib::gmail::{backoff, GmailClient, GmailError};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

#[tokio::test(start_paused = true)]
async fn retries_429_but_fails_other_4xx_and_marks_history_expiry() {
    let server = MockServer::start().await;
    let client = GmailClient::with_base_url("token", server.uri());
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(429))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET")).and(path("/users/me/profile")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"emailAddress":"me@example.com","messagesTotal":0,"threadsTotal":0,"historyId":"1"}))).mount(&server).await;
    let pending = client.profile();
    tokio::pin!(pending);
    tokio::task::yield_now().await;
    tokio::time::advance(backoff(1)).await;
    assert_eq!(pending.await.unwrap().history_id, 1);
    let forbidden = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(403))
        .mount(&forbidden)
        .await;
    assert!(matches!(
        GmailClient::with_base_url("token", forbidden.uri())
            .labels()
            .await,
        Err(GmailError::Http(403))
    ));
    let expired = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&expired)
        .await;
    assert!(matches!(
        GmailClient::with_base_url("token", expired.uri())
            .history_page(1, None)
            .await,
        Err(GmailError::HistoryExpired)
    ));
}

#[tokio::test(start_paused = true)]
async fn a_connection_refused_error_retries_with_backoff_and_is_reported_as_a_network_error() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let client = GmailClient::with_base_url("token", format!("http://127.0.0.1:{port}"));

    let pending = client.profile();
    tokio::pin!(pending);
    for attempt in 1..=9 {
        tokio::task::yield_now().await;
        tokio::time::advance(backoff(attempt)).await;
    }
    tokio::task::yield_now().await;

    assert!(matches!(pending.await, Err(GmailError::Network(_))));
}
