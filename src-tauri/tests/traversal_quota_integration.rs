
use latentmail_lib::gmail::{
    GmailClient, GmailRateLimiters, ACCOUNT_RATE_PER_SECOND, TRAVERSAL_SHARE,
};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};


async fn drain_traversal_bucket(client: &GmailClient) {
    let capacity = (ACCOUNT_RATE_PER_SECOND * TRAVERSAL_SHARE) as usize;
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..(capacity + 5) {
        let client = client.clone();
        tasks.spawn(async move { client.profile().await.unwrap() });
    }
    while tasks.join_next().await.is_some() {}
}

fn profile_body() -> serde_json::Value {
    serde_json::json!({
        "emailAddress": "me@example.com",
        "messagesTotal": 0,
        "threadsTotal": 0,
        "historyId": "1"
    })
}


#[tokio::test]
async fn saturating_traversal_quota_does_not_delay_a_non_traversal_request() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(profile_body()))
        .mount(&server)
        .await;

    let limiters = GmailRateLimiters::default();
    let client = GmailClient::for_account("account", "token", server.uri(), &limiters).await;
    let traversal_client = client.traversal_scoped();

    drain_traversal_bucket(&traversal_client).await;

    let started = std::time::Instant::now();
    client.profile().await.unwrap();
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_millis(15),
        "non-traversal work must obtain tokens without waiting while traversal is saturated \
         (took {elapsed:?}, expected well under the ~25ms traversal-bucket refill tick)"
    );
}


#[tokio::test]
async fn a_traversal_request_beyond_its_cap_genuinely_waits_for_refill() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(profile_body()))
        .mount(&server)
        .await;

    let limiters = GmailRateLimiters::default();
    let client = GmailClient::for_account("account", "token", server.uri(), &limiters).await;
    let traversal_client = client.traversal_scoped();

    drain_traversal_bucket(&traversal_client).await;

    let started = std::time::Instant::now();
    traversal_client.profile().await.unwrap();
    let elapsed = started.elapsed();
    assert!(
        elapsed >= std::time::Duration::from_millis(15),
        "a traversal request beyond its cap must wait for the bucket to refill (took {elapsed:?})"
    );
}
