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
        .respond_with(ResponseTemplate::new(status).set_body_string("rejected"))
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
async fn a_streamed_response_yields_its_content_deltas_in_order() {
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
async fn a_stream_that_breaks_after_a_delta_reports_a_provider_error_instead_of_completing() {
    let server = streaming_server(format!(
        "{}data: {{\"choices\":7}}\n\n",
        frame("half an answer")
    ))
    .await;
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
async fn a_stream_that_closes_cleanly_without_the_done_marker_reports_an_invalid_response() {
    let server = streaming_server(format!("{}{}", frame("half an "), frame("answer"))).await;
    let mut deltas: Vec<String> = Vec::new();
    let outcome = provider(&server)
        .chat_completion_stream("chat", messages(), &AtomicBool::new(false), &mut |delta| {
            deltas.push(delta.to_owned())
        })
        .await;
    assert_eq!(outcome, Err(ProviderError::Response));
    assert_eq!(deltas, vec!["half an ", "answer"]);
}

#[tokio::test]
async fn a_stream_that_yields_no_delta_at_all_reports_an_invalid_response() {
    let server = streaming_server(
        "data: {\"choices\":[]}\n\ndata: {\"id\":\"chunk\"}\n\ndata: [DONE]\n\n".to_owned(),
    )
    .await;
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

#[tokio::test]
async fn inline_think_blocks_are_dropped_even_when_their_tags_split_across_frames() {
    let server = streaming_server(format!(
        "{}{}{}{}{}data: [DONE]\n\n",
        frame("<thin"),
        frame("k>the user wants the date"),
        frame("</thi"),
        frame("nk>The deadline "),
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
    assert_eq!(deltas.concat(), "The deadline is Friday.");
}

#[tokio::test]
async fn an_unterminated_think_block_yields_no_visible_text() {
    let server = streaming_server(format!(
        "{}{}data: [DONE]\n\n",
        frame("<think>still reasoning"),
        frame(" and never stopping")
    ))
    .await;
    let mut deltas: Vec<String> = Vec::new();
    provider(&server)
        .chat_completion_stream("chat", messages(), &AtomicBool::new(false), &mut |delta| {
            deltas.push(delta.to_owned())
        })
        .await
        .unwrap();
    assert!(deltas.is_empty());
}

#[tokio::test]
async fn a_trailing_angle_bracket_that_never_becomes_a_tag_is_still_delivered() {
    let server = streaming_server(format!(
        "{}{}data: [DONE]\n\n",
        frame("compare 3 <"),
        frame(" 5")
    ))
    .await;
    let mut deltas: Vec<String> = Vec::new();
    provider(&server)
        .chat_completion_stream("chat", messages(), &AtomicBool::new(false), &mut |delta| {
            deltas.push(delta.to_owned())
        })
        .await
        .unwrap();
    assert_eq!(deltas.concat(), "compare 3 < 5");
}

#[tokio::test]
async fn a_stream_of_reasoning_that_hits_the_token_limit_names_the_reasoning_budget() {
    let server = streaming_server(
        concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning\":\"let me think\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"\"},\"finish_reason\":\"length\"}]}\n\n",
            "data: [DONE]\n\n"
        )
        .to_owned(),
    )
    .await;
    assert_eq!(
        provider(&server)
            .chat_completion_stream("chat", messages(), &AtomicBool::new(false), &mut |_| {})
            .await
            .unwrap_err(),
        ProviderError::ReasoningBudget
    );
}

#[tokio::test]
async fn a_stream_of_reasoning_that_stops_on_its_own_stays_an_invalid_response() {
    let server = streaming_server(
        concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"let me think\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        )
        .to_owned(),
    )
    .await;
    assert_eq!(
        provider(&server)
            .chat_completion_stream("chat", messages(), &AtomicBool::new(false), &mut |_| {})
            .await
            .unwrap_err(),
        ProviderError::Response
    );
}
