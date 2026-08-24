use std::time::Duration;

use latentmail_lib::ai::{
    index::embed_with_retry,
    provider::{api_root, Provider, ProviderError},
};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

#[test]
fn api_roots_normalize_and_reject_secret_bearing_urls() {
    assert_eq!(
        api_root("http://localhost:11434/v1").unwrap().as_str(),
        "http://localhost:11434/v1/"
    );
    assert_eq!(
        api_root("https://example.com/v1/").unwrap().as_str(),
        "https://example.com/v1/"
    );
    assert!(api_root("https://key@example.com/v1").is_err());
    assert!(api_root("ftp://example.com/v1").is_err());
    assert!(api_root("https://example.com/v1?key=secret").is_err());
}

#[tokio::test]
async fn provider_parses_tolerant_model_embedding_and_chat_responses() {
    let server = MockServer::start().await;
    Mock::given(method("GET")).and(path("/v1/models")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"data":[{"id":"chat","owned_by":"owner","ignored":true},{"id":"embedding"}]}))).mount(&server).await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"data":[{"embedding":[1.0,2.0]}]})),
        )
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"choices":[{"message":{"content":"answer"}}]})),
        )
        .mount(&server)
        .await;
    let provider = Provider::new(&format!("{}/v1", server.uri()), Some("secret".into())).unwrap();
    assert_eq!(provider.models().await.unwrap().len(), 2);
    assert_eq!(
        provider
            .embed("embedding", vec!["hello".into()])
            .await
            .unwrap(),
        vec![vec![1.0, 2.0]]
    );
    assert_eq!(
        provider
            .chat_completion("chat", serde_json::json!([]))
            .await
            .unwrap(),
        "answer"
    );
}

#[tokio::test]
async fn embedding_rate_limits_retry_inside_the_request_with_injected_backoff() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(429))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"data":[{"embedding":[1.0]}]})),
        )
        .mount(&server)
        .await;
    let provider = Provider::new(&format!("{}/v1", server.uri()), None).unwrap();
    assert_eq!(
        embed_with_retry(&provider, "embedding", vec!["mail".into()], 3, |_| {
            Duration::ZERO
        })
        .await
        .unwrap(),
        vec![vec![1.0]]
    );
}

#[tokio::test]
async fn provider_classifies_authentication_server_and_malformed_responses_without_secrets() {
    let server = MockServer::start().await;
    for (endpoint, status, expected) in [
        ("/v1/models", 401, ProviderError::Authentication),
        ("/v1/embeddings", 503, ProviderError::Server),
        ("/v1/chat/completions", 400, ProviderError::Response),
    ] {
        Mock::given(method(if endpoint == "/v1/models" {
            "GET"
        } else {
            "POST"
        }))
        .and(path(endpoint))
        .respond_with(ResponseTemplate::new(status))
        .mount(&server)
        .await;
        let provider =
            Provider::new(&format!("{}/v1", server.uri()), Some("secret".into())).unwrap();
        let error = match endpoint {
            "/v1/models" => provider.models().await.unwrap_err(),
            "/v1/embeddings" => provider
                .embed("embedding", vec!["mail".into()])
                .await
                .unwrap_err(),
            _ => provider
                .chat_completion("chat", serde_json::json!([]))
                .await
                .unwrap_err(),
        };
        assert_eq!(error, expected);
        assert!(!error.to_string().contains("secret"));
    }
}

#[tokio::test]
async fn retries_transient_server_and_transport_failures_with_injected_bounds() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    let server_provider = Provider::new(&format!("{}/v1", server.uri()), None).unwrap();
    assert_eq!(
        embed_with_retry(
            &server_provider,
            "embedding",
            vec!["mail".into()],
            2,
            |_| Duration::ZERO
        )
        .await
        .unwrap_err(),
        ProviderError::Server.to_string()
    );
    let transport_provider = Provider::new("http://127.0.0.1:9/v1", None).unwrap();
    assert_eq!(
        embed_with_retry(
            &transport_provider,
            "embedding",
            vec!["mail".into()],
            2,
            |_| Duration::ZERO
        )
        .await
        .unwrap_err(),
        ProviderError::Transport.to_string()
    );
}
