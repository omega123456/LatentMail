use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    task::{Context, Poll},
};

use async_openai::{
    config::OpenAIConfig,
    error::{ApiError, ApiErrorResponse, OpenAIError},
    middleware::HttpRequestFactory,
    types::stream::StreamResponse,
    Client,
};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use reqwest::{header::AUTHORIZATION, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use thiserror::Error;
use tower::Service;
use url::Url;

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ProviderError {
    #[error("Could not connect to provider")]
    Transport,
    #[error("Provider rate limited the request")]
    RateLimited,
    #[error("Provider returned a server error")]
    Server,
    #[error("Provider rejected authentication")]
    Authentication,
    #[error("Provider returned an invalid response")]
    Response,
    #[error("The model reached its token limit while reasoning and returned no answer")]
    ReasoningBudget,
}

impl ProviderError {
    pub fn transient(&self) -> bool {
        matches!(self, Self::Transport | Self::RateLimited | Self::Server)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    pub owned_by: Option<String>,
}

fn full_reasoning_off_fields() -> Value {
    json!({
        "reasoning_effort": "none",
        "reasoning": {"enabled": false, "exclude": true},
        "thinking": {"type": "disabled", "budget_tokens": 0},
        "enable_thinking": false,
        "think": false,
        "thinking_budget": 0,
        "reasoning_budget": 0,
        "thinking_budget_tokens": 0,
        "chat_template_kwargs": {"enable_thinking": false, "thinking": false, "reasoning": false},
        "google": {"thinking_config": {"thinking_budget": 0, "include_thoughts": false}},
    })
}

fn none_effort_fields() -> Value {
    json!({"reasoning_effort": "none"})
}

fn low_effort_fields() -> Value {
    json!({"reasoning_effort": "low"})
}

const REASONING_OFF_TIERS: [fn() -> Value; 3] = [
    full_reasoning_off_fields,
    none_effort_fields,
    low_effort_fields,
];

pub fn reasoning_off_fields(tier: usize) -> Map<String, Value> {
    let Some(builder) = REASONING_OFF_TIERS.get(tier) else {
        return Map::new();
    };
    match builder() {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

pub const TEMPERATURE: f64 = 0.0;
pub const SEED: i64 = 20_260_827;
pub const MAX_TOKENS: i64 = 16_384;

const LAST_REASONING_TIER: usize = REASONING_OFF_TIERS.len();
const THINK_OPEN: [&str; 3] = ["<think>", "<thinking>", "<reasoning>"];
const THINK_CLOSE: [&str; 3] = ["</think>", "</thinking>", "</reasoning>"];

#[derive(Default)]
pub struct ThinkFilter {
    pending: String,
    inside: bool,
}

struct TagSpan {
    start: usize,
    length: usize,
}

impl ThinkFilter {
    fn active_tags(&self) -> [&'static str; 3] {
        if self.inside {
            return THINK_CLOSE;
        }
        THINK_OPEN
    }

    pub fn push(&mut self, delta: &str) -> String {
        self.pending.push_str(delta);
        let mut visible = String::new();
        while self.consume_next_tag(&mut visible) {}
        self.release_untagged_text(&mut visible);
        visible
    }

    fn consume_next_tag(&mut self, visible: &mut String) -> bool {
        let tags = self.active_tags();
        let Some(span) = first_tag(&self.pending, &tags) else {
            return false;
        };
        self.emit_unless_inside(visible, span.start);
        self.pending.replace_range(..span.start + span.length, "");
        self.inside = !self.inside;
        true
    }

    fn release_untagged_text(&mut self, visible: &mut String) {
        let tags = self.active_tags();
        let held = self.pending.len() - partial_tag_len(&self.pending, &tags);
        self.emit_unless_inside(visible, held);
        self.pending.replace_range(..held, "");
    }

    fn emit_unless_inside(&self, visible: &mut String, end: usize) {
        if self.inside {
            return;
        }
        visible.push_str(&self.pending[..end]);
    }

    pub fn flush(&mut self) -> String {
        if self.inside {
            self.pending.clear();
            return String::new();
        }
        std::mem::take(&mut self.pending)
    }
}

pub fn strip_think_blocks(text: &str) -> String {
    let mut filter = ThinkFilter::default();
    let mut stripped = filter.push(text);
    stripped.push_str(&filter.flush());
    stripped.trim().to_owned()
}

fn first_tag(text: &str, tags: &[&str]) -> Option<TagSpan> {
    tags.iter()
        .filter_map(|tag| {
            text.find(tag).map(|start| TagSpan {
                start: start,
                length: tag.len(),
            })
        })
        .min_by_key(|span| span.start)
}

fn partial_tag_len(text: &str, tags: &[&str]) -> usize {
    tags.iter()
        .flat_map(|tag| (1..tag.len()).filter(|end| text.ends_with(&tag[..*end])))
        .max()
        .unwrap_or(0)
}

const STREAM_REQUEST_MARKER: &[u8] = b"\"stream\":true";
const TRUNCATION_SENTINEL_FRAME: &[u8] = b"\n\ndata: {\"streamEndedWithoutDoneMarker\":true}\n\n";

#[derive(Clone)]
struct StatusPreservingTransport {
    client: reqwest::Client,
    authorized: bool,
}

impl Service<HttpRequestFactory> for StatusPreservingTransport {
    type Response = Response;
    type Error = OpenAIError;
    type Future = Pin<Box<dyn Future<Output = Result<Response, OpenAIError>> + Send>>;

    fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, factory: HttpRequestFactory) -> Self::Future {
        Box::pin(forward_preserving_status(
            self.client.clone(),
            self.authorized,
            factory,
        ))
    }
}

async fn forward_preserving_status(
    client: reqwest::Client,
    authorized: bool,
    factory: HttpRequestFactory,
) -> Result<Response, OpenAIError> {
    let mut request = factory.build().await?;
    if !authorized {
        request.headers_mut().remove(AUTHORIZATION);
    }
    let streaming = asks_for_a_stream(&request);
    let route = format!("{} {}", request.method(), request.url());
    tracing::debug!(
        target: "ai",
        "request {route} {}",
        preview(request.body().and_then(reqwest::Body::as_bytes).unwrap_or_default())
    );
    let response = client.execute(request).await.map_err(|error| {
        tracing::debug!(target: "ai", "request {route} failed: {error}");
        OpenAIError::Reqwest(error)
    })?;
    let status = response.status();
    let parts = parts_of(&response);
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        tracing::debug!(target: "ai", "response {route} {status} {}", preview(body.as_bytes()));
        return Err(status_error(status, body));
    }
    if streaming {
        tracing::debug!(target: "ai", "response {route} {status} streaming");
        return Ok(rebuilt(
            parts,
            reqwest::Body::wrap_stream(with_trailing_sentinel(response.bytes_stream(), route)),
        ));
    }
    let body = response.bytes().await.map_err(OpenAIError::Reqwest)?;
    tracing::debug!(target: "ai", "response {route} {status} {}", preview(&body));
    Ok(rebuilt(parts, reqwest::Body::from(body)))
}

const PREVIEW_EDGE: usize = 4096;

fn preview(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let Some((head, _)) = text.char_indices().nth(PREVIEW_EDGE) else {
        return text.into_owned();
    };
    let tail = text
        .char_indices()
        .nth_back(PREVIEW_EDGE)
        .map_or(head, |(at, _)| at.max(head));
    format!(
        "{}… [{} bytes elided] …{}",
        &text[..head],
        text[head..tail].len(),
        &text[tail..]
    )
}

fn asks_for_a_stream(request: &reqwest::Request) -> bool {
    request
        .body()
        .and_then(reqwest::Body::as_bytes)
        .is_some_and(|body| {
            body.windows(STREAM_REQUEST_MARKER.len())
                .any(|window| window == STREAM_REQUEST_MARKER)
        })
}

fn status_error(status: StatusCode, body: String) -> OpenAIError {
    OpenAIError::ApiError(ApiErrorResponse {
        status_code: status,
        api_error: ApiError {
            message: body,
            r#type: None,
            param: None,
            code: None,
        },
    })
}

fn parts_of(response: &Response) -> http::response::Parts {
    let (mut parts, ()) = http::Response::new(()).into_parts();
    parts.status = response.status();
    parts.version = response.version();
    parts.headers = response.headers().clone();
    parts
}

fn rebuilt(parts: http::response::Parts, body: reqwest::Body) -> Response {
    http::Response::from_parts(parts, body).into()
}

fn with_trailing_sentinel(
    stream: impl Stream<Item = reqwest::Result<Bytes>> + Send + 'static,
    route: String,
) -> impl Stream<Item = reqwest::Result<Bytes>> + Send + 'static {
    futures_util::stream::unfold(Some(Box::pin(stream)), move |state| {
        next_stream_frame(state, route.clone())
    })
}

async fn next_stream_frame<ByteStream>(
    state: Option<Pin<Box<ByteStream>>>,
    route: String,
) -> Option<(reqwest::Result<Bytes>, Option<Pin<Box<ByteStream>>>)>
where
    ByteStream: Stream<Item = reqwest::Result<Bytes>> + Send,
{
    let mut stream = state?;
    let Some(item) = stream.next().await else {
        return Some((Ok(Bytes::from_static(TRUNCATION_SENTINEL_FRAME)), None));
    };
    log_stream_item(&route, &item);
    Some((item, Some(stream)))
}

fn log_stream_item(route: &str, item: &reqwest::Result<Bytes>) {
    match item {
        Ok(bytes) => tracing::debug!(target: "ai", "stream {route} {}", preview(bytes)),
        Err(error) => tracing::debug!(target: "ai", "stream {route} failed: {error}"),
    }
}

#[derive(Clone)]
pub struct Provider {
    client: Client<OpenAIConfig>,
    reasoning_tier: Arc<AtomicUsize>,
}

pub struct ChatCompletionRequest<'a> {
    pub model: &'a str,
    pub messages: Value,
    pub response_format: Option<Value>,
}

pub struct ChatStreamRequest<'a> {
    pub model: &'a str,
    pub messages: Value,
    pub cancel: &'a AtomicBool,
}

struct SendRequest<'a> {
    model: &'a str,
    messages: &'a Value,
    stream: bool,
    response_format: Option<Value>,
}

impl Provider {
    pub fn new(base_url: &str, api_key: Option<String>) -> Result<Self, String> {
        let root = api_root(base_url)?;
        let authorized = api_key.as_deref().is_some_and(|key| !key.is_empty());
        let config = OpenAIConfig::new()
            .with_api_base(root.as_str().trim_end_matches('/'))
            .with_api_key(api_key.unwrap_or_default());
        let transport = crate::http_client();
        Ok(Self {
            client: Client::build(transport.clone(), config).with_http_service(
                StatusPreservingTransport {
                    client: transport,
                    authorized: authorized,
                },
            ),
            reasoning_tier: Arc::new(AtomicUsize::new(0)),
        })
    }
    pub async fn models(&self) -> Result<Vec<ProviderModel>, ProviderError> {
        let response: ModelsResponse = self
            .client
            .models()
            .list_byot()
            .await
            .map_err(provider_error)?;
        Ok(response
            .data
            .into_iter()
            .map(|model| ProviderModel {
                id: model.id,
                owned_by: model.owned_by,
            })
            .collect())
    }
    pub async fn embed(
        &self,
        model: &str,
        input: Vec<String>,
    ) -> Result<Vec<Vec<f32>>, ProviderError> {
        let response: EmbeddingsResponse = self
            .client
            .embeddings()
            .create_byot(json!({"model": model, "input": input}))
            .await
            .map_err(provider_error)?;
        Ok(response
            .data
            .into_iter()
            .map(|item| item.embedding)
            .collect())
    }
    pub async fn chat_completion(
        &self,
        request: ChatCompletionRequest<'_>,
    ) -> Result<String, ProviderError> {
        let response: ChatResponse = self
            .send(
                SendRequest {
                    model: request.model,
                    messages: &request.messages,
                    stream: false,
                    response_format: request.response_format,
                },
                |body| async move { self.client.chat().create_byot(body).await },
            )
            .await?;
        let choice = response.choices.into_iter().next();
        let reasoned = choice.as_ref().is_some_and(ChatChoice::reasoned);
        let truncated = choice.as_ref().is_some_and(ChatChoice::truncated);
        choice
            .and_then(|choice| choice.message.and_then(|message| message.content))
            .map(|content| strip_think_blocks(&content))
            .filter(|content| !content.is_empty())
            .ok_or_else(|| empty_answer(reasoned, truncated))
    }
    pub async fn chat_completion_stream(
        &self,
        request: ChatStreamRequest<'_>,
        on_delta: &mut (dyn FnMut(&str) + Send),
    ) -> Result<(), ProviderError> {
        let mut stream: StreamResponse<StreamChunk> = self
            .send(
                SendRequest {
                    model: request.model,
                    messages: &request.messages,
                    stream: true,
                    response_format: None,
                },
                |body| async move { self.client.chat().create_stream_byot(body).await },
            )
            .await?;
        let mut progress = StreamProgress::default();
        while let Some(item) = next_uncancelled_item(&mut stream, request.cancel).await {
            progress.absorb(item.map_err(provider_error)?, on_delta)?;
        }
        if request.cancel.load(Ordering::SeqCst) {
            return Ok(());
        }
        progress.finish(on_delta)
    }
    async fn send<T, F, Fut>(&self, request: SendRequest<'_>, call: F) -> Result<T, ProviderError>
    where
        F: Fn(Value) -> Fut,
        Fut: std::future::Future<Output = Result<T, OpenAIError>>,
    {
        let mut tier = self.reasoning_tier.load(Ordering::SeqCst);
        let mut attempt = call(chat_body(&request, tier)).await;
        while should_step_down(&attempt, tier) {
            self.reasoning_tier.store(tier + 1, Ordering::SeqCst);
            tier = self.reasoning_tier.load(Ordering::SeqCst);
            attempt = call(chat_body(&request, tier)).await;
        }
        attempt.map_err(provider_error)
    }
}

fn should_step_down<T>(attempt: &Result<T, OpenAIError>, tier: usize) -> bool {
    let rejected = matches!(attempt, Err(error) if rejects_the_request(error));
    rejected && tier < LAST_REASONING_TIER
}

async fn next_uncancelled_item(
    stream: &mut StreamResponse<StreamChunk>,
    cancel: &AtomicBool,
) -> Option<Result<StreamChunk, OpenAIError>> {
    let item = stream.next().await?;
    if cancel.load(Ordering::SeqCst) {
        return None;
    }
    Some(item)
}

#[derive(Default)]
struct StreamProgress {
    think: ThinkFilter,
    delivered: bool,
    reasoned: bool,
    truncated: bool,
}

impl StreamProgress {
    fn absorb(
        &mut self,
        chunk: StreamChunk,
        on_delta: &mut (dyn FnMut(&str) + Send),
    ) -> Result<(), ProviderError> {
        if chunk.stream_ended_without_done_marker {
            tracing::debug!(target: "ai", "chat stream ended without a done marker");
            return Err(ProviderError::Response);
        }
        let Some(choice) = chunk.choices.into_iter().next() else {
            return Ok(());
        };
        self.reasoned |= choice.reasoned();
        self.truncated |= choice.truncated();
        let Some(text) = choice
            .delta
            .and_then(|delta| delta.content)
            .filter(|text| !text.is_empty())
        else {
            return Ok(());
        };
        self.delivered = true;
        let visible = self.think.push(&text);
        emit_if_visible(&visible, on_delta);
        Ok(())
    }

    fn finish(mut self, on_delta: &mut (dyn FnMut(&str) + Send)) -> Result<(), ProviderError> {
        let tail = self.think.flush();
        emit_if_visible(&tail, on_delta);
        if self.delivered {
            return Ok(());
        }
        Err(empty_answer(self.reasoned, self.truncated))
    }
}

fn emit_if_visible(text: &str, on_delta: &mut (dyn FnMut(&str) + Send)) {
    if text.is_empty() {
        return;
    }
    on_delta(text);
}

fn chat_body(request: &SendRequest<'_>, tier: usize) -> Value {
    let mut body = Map::new();
    body.insert("model".to_owned(), Value::String(request.model.to_owned()));
    body.insert("messages".to_owned(), request.messages.clone());
    body.insert("stream".to_owned(), Value::Bool(request.stream));
    body.insert("temperature".to_owned(), json!(TEMPERATURE));
    body.insert("seed".to_owned(), json!(SEED));
    body.insert("max_tokens".to_owned(), json!(MAX_TOKENS));
    if let Some(format) = request.response_format.clone() {
        body.insert("response_format".to_owned(), format);
    }
    body.extend(reasoning_off_fields(tier));
    Value::Object(body)
}

fn rejects_the_request(error: &OpenAIError) -> bool {
    matches!(error, OpenAIError::ApiError(response) if response.status_code.as_u16() == 400)
}

pub fn api_root(input: &str) -> Result<Url, String> {
    let mut url = Url::parse(input).map_err(|_| "API root must be an absolute URL".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("API root must use HTTP or HTTPS".to_owned());
    }
    let has_credentials = !url.username().is_empty() || url.password().is_some();
    if has_credentials {
        return Err("API root must not contain credentials".to_owned());
    }
    let has_query_or_fragment = url.query().is_some() || url.fragment().is_some();
    if has_query_or_fragment {
        return Err("API root must not contain a query or fragment".to_owned());
    }
    if url.host_str().is_none() {
        return Err("API root must include a host".to_owned());
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

const STATUS_ERROR_RULES: &[(u16, u16, ProviderError)] = &[
    (401, 401, ProviderError::Authentication),
    (403, 403, ProviderError::Authentication),
    (429, 429, ProviderError::RateLimited),
    (500, 599, ProviderError::Server),
];

fn api_status_error(status: u16) -> ProviderError {
    STATUS_ERROR_RULES
        .iter()
        .find(|(min_code, max_code, _)| (*min_code..=*max_code).contains(&status))
        .map_or(ProviderError::Response, |(_, _, error)| error.clone())
}

fn provider_error(error: OpenAIError) -> ProviderError {
    match error {
        OpenAIError::ApiError(response) => api_status_error(response.status_code.as_u16()),
        OpenAIError::Reqwest(_) | OpenAIError::StreamError(_) => ProviderError::Transport,
        _ => ProviderError::Response,
    }
}
#[derive(Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelResponse>,
}
#[derive(Deserialize)]
struct ModelResponse {
    id: String,
    #[serde(default)]
    owned_by: Option<String>,
}
#[derive(Deserialize)]
struct EmbeddingsResponse {
    #[serde(default)]
    data: Vec<EmbeddingResponse>,
}
#[derive(Deserialize)]
struct EmbeddingResponse {
    embedding: Vec<f32>,
}
const LENGTH_FINISH_REASON: &str = "length";

fn empty_answer(reasoned: bool, truncated: bool) -> ProviderError {
    tracing::debug!(target: "ai", "chat produced no answer (reasoned={reasoned}, truncated={truncated})");
    if reasoned && truncated {
        return ProviderError::ReasoningBudget;
    }
    ProviderError::Response
}

#[derive(Deserialize)]
struct ChatResponse {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}
#[derive(Deserialize)]
struct ChatChoice {
    #[serde(default)]
    message: Option<ChatMessage>,
    #[serde(default)]
    finish_reason: Option<String>,
}
#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: Option<ChatMessage>,
    #[serde(default)]
    finish_reason: Option<String>,
}
#[derive(Deserialize)]
struct ChatMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    #[serde(default)]
    stream_ended_without_done_marker: bool,
}

impl ChatMessage {
    fn reasoned(&self) -> bool {
        [self.reasoning.as_deref(), self.reasoning_content.as_deref()]
            .into_iter()
            .flatten()
            .any(|text| !text.is_empty())
    }
}

impl ChatChoice {
    fn reasoned(&self) -> bool {
        self.message.as_ref().is_some_and(ChatMessage::reasoned)
    }
    fn truncated(&self) -> bool {
        self.finish_reason.as_deref() == Some(LENGTH_FINISH_REASON)
    }
}

impl StreamChoice {
    fn reasoned(&self) -> bool {
        self.delta.as_ref().is_some_and(ChatMessage::reasoned)
    }
    fn truncated(&self) -> bool {
        self.finish_reason.as_deref() == Some(LENGTH_FINISH_REASON)
    }
}
