use std::time::Duration;

use latentmail_lib::ai::{
    index::embed_with_retry,
    provider::{api_root, reasoning_off_fields, strip_think_blocks, Provider, ProviderError},
};
use wiremock::{
    matchers::{body_partial_json, method, path},
    Mock, MockServer, ResponseTemplate,
};

fn refused(status: u16, message: &str) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_string(message)
}

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
            .chat_completion("chat", serde_json::json!([]), None)
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
        .respond_with(refused(429, "slow down"))
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
        .respond_with(refused(status, "rejected"))
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
                .chat_completion("chat", serde_json::json!([]), None)
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

#[tokio::test]
async fn chat_requests_carry_every_reasoning_off_key_and_step_down_when_the_provider_rejects_them()
{
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_partial_json(
            serde_json::json!({"reasoning_effort":"low"}),
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"choices":[{"message":{"content":"answer"}}]})),
        )
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(refused(400, "unrecognized request argument"))
        .mount(&server)
        .await;
    let provider = Provider::new(&format!("{}/v1", server.uri()), None).unwrap();
    assert_eq!(
        provider
            .chat_completion("chat", serde_json::json!([]), None)
            .await
            .unwrap(),
        "answer"
    );
    assert_eq!(
        provider
            .chat_completion("chat", serde_json::json!([]), None)
            .await
            .unwrap(),
        "answer"
    );
    let bodies = server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .map(|request| serde_json::from_slice::<serde_json::Value>(&request.body).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(bodies.len(), 4);
    for key in [
        "reasoning_effort",
        "reasoning",
        "thinking",
        "enable_thinking",
        "think",
        "thinking_budget",
        "reasoning_budget",
        "thinking_budget_tokens",
        "chat_template_kwargs",
        "google",
    ] {
        assert!(
            bodies[0].get(key).is_some(),
            "{key} missing from first body"
        );
    }
    assert_eq!(bodies[1]["reasoning_effort"], "none");
    assert!(bodies[1].get("thinking").is_none());
    assert_eq!(bodies[3]["reasoning_effort"], "low");
}

#[tokio::test]
async fn a_rejection_whose_body_is_not_an_openai_error_object_still_steps_the_reasoning_tier_down()
{
    for body in [
        ResponseTemplate::new(400).set_body_string("Unrecognized request argument supplied: think"),
        ResponseTemplate::new(400),
        ResponseTemplate::new(400).set_body_json(serde_json::json!({"error":"a bare string"})),
    ] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(body_partial_json(
                serde_json::json!({"reasoning_effort":"low"}),
            ))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(
                    serde_json::json!({"choices":[{"message":{"content":"answer"}}]}),
                ),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(body)
            .mount(&server)
            .await;
        let provider = Provider::new(&format!("{}/v1", server.uri()), None).unwrap();
        assert_eq!(
            provider
                .chat_completion("chat", serde_json::json!([]), None)
                .await
                .unwrap(),
            "answer"
        );
        assert_eq!(server.received_requests().await.unwrap().len(), 3);
    }
}

#[tokio::test]
async fn a_rate_limit_whose_body_is_not_an_openai_error_object_is_still_transient() {
    for body in [
        ResponseTemplate::new(429).set_body_string("Too Many Requests"),
        ResponseTemplate::new(429),
        ResponseTemplate::new(429).set_body_json(serde_json::json!({"error":"a bare string"})),
    ] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/embeddings"))
            .respond_with(body)
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
        assert!(provider
            .embed("embedding", vec!["mail".into()])
            .await
            .unwrap_err()
            .transient());
        assert_eq!(
            embed_with_retry(&provider, "embedding", vec!["mail".into()], 3, |_| {
                Duration::ZERO
            })
            .await
            .unwrap(),
            vec![vec![1.0]]
        );
    }
}

#[tokio::test]
async fn the_authorization_header_is_sent_only_when_a_key_is_stored() {
    for (key, expected) in [
        (None, None),
        (Some("secret".to_owned()), Some("Bearer secret")),
    ] {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data":[{"id":"chat"}]})),
            )
            .mount(&server)
            .await;
        Provider::new(&format!("{}/v1", server.uri()), key)
            .unwrap()
            .models()
            .await
            .unwrap();
        let requested = server.received_requests().await.unwrap();
        assert_eq!(
            requested[0]
                .headers
                .get("authorization")
                .map(|value| value.to_str().unwrap()),
            expected
        );
    }
}

#[tokio::test]
async fn reasoning_off_tiers_end_in_an_empty_field_set() {
    assert_eq!(
        reasoning_off_fields(1)
            .into_iter()
            .collect::<Vec<_>>()
            .len(),
        1
    );
    assert!(reasoning_off_fields(3).is_empty());
}

#[test]
fn think_blocks_are_stripped_from_whole_responses_without_touching_ordinary_text() {
    assert_eq!(
        strip_think_blocks("<think>weighing it up</think>\n{\"relevant\":true}"),
        "{\"relevant\":true}"
    );
    assert_eq!(
        strip_think_blocks("<reasoning>a</reasoning>keep<thinking>b</thinking>this"),
        "keepthis"
    );
    assert_eq!(strip_think_blocks("3 < 5 and 7 > 2"), "3 < 5 and 7 > 2");
    assert_eq!(strip_think_blocks("plain answer"), "plain answer");
}

#[tokio::test]
async fn a_base_url_stored_with_a_trailing_slash_still_addresses_a_single_joined_path() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"data":[{"id":"chat"}]})),
        )
        .mount(&server)
        .await;
    let provider = Provider::new(&format!("{}/v1/", server.uri()), None).unwrap();
    assert_eq!(provider.models().await.unwrap().len(), 1);
    let requested = server.received_requests().await.unwrap();
    assert_eq!(requested[0].url.path(), "/v1/models");
}
