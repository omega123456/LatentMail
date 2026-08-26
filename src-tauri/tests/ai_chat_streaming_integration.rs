use std::sync::atomic::{AtomicBool, Ordering};

use latentmail_lib::ai::provider::{Provider, ProviderError};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn frame(text: &str) -> String {
    format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"{text}\"}}}}]}}\n\n")
}

async fn streaming_server(body: String) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(body),
        )
        .mount(&server)
        .await;
    server
}

async fn failing_server(status: u16) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(status))
        .mount(&server)
        .await;
    server
}

fn provider(server: &MockServer) -> Provider {
    Provider::new(&format!("{}/v1", server.uri()), Some("secret".into())).unwrap()
}

fn messages() -> serde_json::Value {
    serde_json::json!([{"role": "user", "content": "what is the deadline"}])
}

#[tokio::test]
async fn a_streamed_response_yields_its_content_deltas_in_order_until_the_terminating_marker() {
    let server = streaming_server(format!(
        "{}{}{}data: [DONE]\n\n",
        frame("The deadline "),
        ": keep-alive comment\n\n",
        frame("is Friday.")
    ))
    .await;
    let mut deltas: Vec<String> = Vec::new();
    provider(&server)
        .chat_completion_stream("chat", messages(), &AtomicBool::new(false), &mut |delta| {
            deltas.push(delta.to_owned())
        })
        .await
        .unwrap();
    assert_eq!(deltas, vec!["The deadline ", "is Friday."]);
}

#[tokio::test]
async fn carriage_returns_and_empty_content_frames_do_not_break_frame_parsing() {
    let server = streaming_server(format!(
        "data: {{\"choices\":[{{\"delta\":{{\"content\":\"\"}}}}]}}\r\n\r\n{}data: [DONE]\r\n\r\n",
        frame("only text")
    ))
    .await;
    let mut deltas: Vec<String> = Vec::new();
    provider(&server)
        .chat_completion_stream("chat", messages(), &AtomicBool::new(false), &mut |delta| {
            deltas.push(delta.to_owned())
        })
        .await
        .unwrap();
    assert_eq!(deltas, vec!["only text"]);
}

#[tokio::test]
async fn a_truncated_stream_reports_an_invalid_response_instead_of_completing() {
    let server = streaming_server(frame("half an answer")).await;
    let mut deltas: Vec<String> = Vec::new();
    let outcome = provider(&server)
        .chat_completion_stream("chat", messages(), &AtomicBool::new(false), &mut |delta| {
            deltas.push(delta.to_owned())
        })
        .await;
    assert_eq!(outcome, Err(ProviderError::Response));
    assert_eq!(deltas, vec!["half an answer"]);
}

#[tokio::test]
async fn a_malformed_frame_reports_an_invalid_response() {
    let server = streaming_server("data: {not json}\n\ndata: [DONE]\n\n".to_owned()).await;
    let outcome = provider(&server)
        .chat_completion_stream("chat", messages(), &AtomicBool::new(false), &mut |_| {})
        .await;
    assert_eq!(outcome, Err(ProviderError::Response));
}

#[tokio::test]
async fn transport_failures_keep_the_existing_error_mapping() {
    let unauthorized = failing_server(401).await;
    assert_eq!(
        provider(&unauthorized)
            .chat_completion_stream("chat", messages(), &AtomicBool::new(false), &mut |_| {})
            .await,
        Err(ProviderError::Authentication)
    );
    let rate_limited = failing_server(429).await;
    assert_eq!(
        provider(&rate_limited)
            .chat_completion_stream("chat", messages(), &AtomicBool::new(false), &mut |_| {})
            .await,
        Err(ProviderError::RateLimited)
    );
    let broken = failing_server(503).await;
    assert_eq!(
        provider(&broken)
            .chat_completion_stream("chat", messages(), &AtomicBool::new(false), &mut |_| {})
            .await,
        Err(ProviderError::Server)
    );
}

#[tokio::test]
async fn cancelling_before_the_body_is_read_delivers_nothing_and_reports_no_error() {
    let server = streaming_server(format!("{}data: [DONE]\n\n", frame("unwanted"))).await;
    let mut deltas: Vec<String> = Vec::new();
    provider(&server)
        .chat_completion_stream("chat", messages(), &AtomicBool::new(true), &mut |delta| {
            deltas.push(delta.to_owned())
        })
        .await
        .unwrap();
    assert!(deltas.is_empty());
}

#[tokio::test]
async fn cancelling_mid_stream_keeps_what_arrived_and_stops_reading_the_rest() {
    let server = streaming_server(format!(
        "{}{}{}data: [DONE]\n\n",
        frame("kept"),
        frame("dropped"),
        frame("also dropped")
    ))
    .await;
    let cancel = AtomicBool::new(false);
    let mut deltas: Vec<String> = Vec::new();
    provider(&server)
        .chat_completion_stream("chat", messages(), &cancel, &mut |delta| {
            deltas.push(delta.to_owned());
            cancel.store(true, Ordering::SeqCst);
        })
        .await
        .unwrap();
    assert_eq!(deltas, vec!["kept"]);
}
