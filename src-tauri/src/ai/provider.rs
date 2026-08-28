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

pub fn reasoning_off_fields(tier: usize) -> Map<String, Value> {
    let fields = match tier {
        0 => json!({
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
        }),
        1 => json!({"reasoning_effort": "none"}),
        2 => json!({"reasoning_effort": "low"}),
        _ => json!({}),
    };
    match fields {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

pub const TEMPERATURE: f64 = 0.0;
pub const SEED: i64 = 20_260_827;
pub const MAX_TOKENS: i64 = 2048;

const LAST_REASONING_TIER: usize = 3;
const THINK_OPEN: [&str; 3] = ["<think>", "<thinking>", "<reasoning>"];
const THINK_CLOSE: [&str; 3] = ["</think>", "</thinking>", "</reasoning>"];

#[derive(Default)]
pub struct ThinkFilter {
    pending: String,
    inside: bool,
}

impl ThinkFilter {
    pub fn push(&mut self, delta: &str) -> String {
        self.pending.push_str(delta);
        let mut visible = String::new();
        loop {
            let tags = if self.inside { THINK_CLOSE } else { THINK_OPEN };
            match first_tag(&self.pending, &tags) {
                Some((at, len)) => {
                    if !self.inside {
                        visible.push_str(&self.pending[..at]);
                    }
                    self.pending.replace_range(..at + len, "");
                    self.inside = !self.inside;
                }
                None => {
                    let held = self.pending.len() - partial_tag_len(&self.pending, &tags);
                    if !self.inside {
                        visible.push_str(&self.pending[..held]);
                    }
                    self.pending.replace_range(..held, "");
                    return visible;
                }
            }
        }
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

fn first_tag(text: &str, tags: &[&str]) -> Option<(usize, usize)> {
    tags.iter()
        .filter_map(|tag| text.find(tag).map(|at| (at, tag.len())))
        .min_by_key(|(at, _)| *at)
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
        let client = self.client.clone();
        let authorized = self.authorized;
        Box::pin(async move {
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
                    reqwest::Body::wrap_stream(with_trailing_sentinel(
                        response.bytes_stream(),
                        route,
                    )),
                ));
            }
            let body = response.bytes().await.map_err(OpenAIError::Reqwest)?;
            tracing::debug!(target: "ai", "response {route} {status} {}", preview(&body));
            Ok(rebuilt(parts, reqwest::Body::from(body)))
        })
    }
}

const PREVIEW_LIMIT: usize = 8192;

fn preview(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    match text.char_indices().nth(PREVIEW_LIMIT) {
        Some((at, _)) => format!("{}… [{} bytes total]", &text[..at], body.len()),
        None => text.into_owned(),
    }
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
    futures_util::stream::unfold(
        (Some(Box::pin(stream)), Vec::new()),
        move |(state, mut seen)| {
            let route = route.clone();
            async move {
                let mut stream = state?;
                match stream.next().await {
                    Some(Ok(bytes)) => {
                        seen.extend_from_slice(&bytes);
                        Some((Ok(bytes), (Some(stream), seen)))
                    }
                    Some(Err(error)) => {
                        tracing::debug!(target: "ai", "stream {route} failed: {error}");
                        Some((Err(error), (Some(stream), seen)))
                    }
                    None => {
                        tracing::debug!(target: "ai", "stream {route} body {}", preview(&seen));
                        Some((
                            Ok(Bytes::from_static(TRUNCATION_SENTINEL_FRAME)),
                            (None, seen),
                        ))
                    }
                }
            }
        },
    )
}

#[derive(Clone)]
pub struct Provider {
    client: Client<OpenAIConfig>,
    reasoning_tier: Arc<AtomicUsize>,
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
                    authorized,
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
        model: &str,
        messages: Value,
        response_format: Option<Value>,
    ) -> Result<String, ProviderError> {
        let response: ChatResponse = self
            .send(
                model,
                &messages,
                false,
                response_format,
                |body| async move { self.client.chat().create_byot(body).await },
            )
            .await?;
        response
            .choices
            .into_iter()
            .find_map(|choice| choice.message.and_then(|message| message.content))
            .map(|content| strip_think_blocks(&content))
            .ok_or_else(|| {
                tracing::debug!(target: "ai", "chat completion carried no message content");
                ProviderError::Response
            })
    }
    pub async fn chat_completion_stream(
        &self,
        model: &str,
        messages: Value,
        cancel: &AtomicBool,
        on_delta: &mut (dyn FnMut(&str) + Send),
    ) -> Result<(), ProviderError> {
        let mut stream: StreamResponse<StreamChunk> = self
            .send(model, &messages, true, None, |body| async move {
                self.client.chat().create_stream_byot(body).await
            })
            .await?;
        let mut think = ThinkFilter::default();
        let mut delivered = false;
        while let Some(item) = stream.next().await {
            if cancel.load(Ordering::SeqCst) {
                return Ok(());
            }
            let chunk = item.map_err(provider_error)?;
            if chunk.stream_ended_without_done_marker {
                tracing::debug!(target: "ai", "chat stream ended without a done marker");
                return Err(ProviderError::Response);
            }
            let Some(text) = chunk
                .choices
                .into_iter()
                .find_map(|choice| choice.delta.and_then(|delta| delta.content))
                .filter(|text| !text.is_empty())
            else {
                continue;
            };
            delivered = true;
            let visible = think.push(&text);
            if !visible.is_empty() {
                on_delta(&visible);
            }
        }
        if cancel.load(Ordering::SeqCst) {
            return Ok(());
        }
        let tail = think.flush();
        if !tail.is_empty() {
            on_delta(&tail);
        }
        if delivered {
            Ok(())
        } else {
            tracing::debug!(target: "ai", "chat stream delivered no content deltas");
            Err(ProviderError::Response)
        }
    }
    async fn send<T, F, Fut>(
        &self,
        model: &str,
        messages: &Value,
        stream: bool,
        response_format: Option<Value>,
        call: F,
    ) -> Result<T, ProviderError>
    where
        F: Fn(Value) -> Fut,
        Fut: std::future::Future<Output = Result<T, OpenAIError>>,
    {
        loop {
            let tier = self.reasoning_tier.load(Ordering::SeqCst);
            match call(chat_body(
                model,
                messages,
                stream,
                response_format.clone(),
                tier,
            ))
            .await
            {
                Ok(value) => return Ok(value),
                Err(error) => {
                    if rejects_the_request(&error) && tier < LAST_REASONING_TIER {
                        self.reasoning_tier.store(tier + 1, Ordering::SeqCst);
                        continue;
                    }
                    return Err(provider_error(error));
                }
            }
        }
    }
}

fn chat_body(
    model: &str,
    messages: &Value,
    stream: bool,
    response_format: Option<Value>,
    tier: usize,
) -> Value {
    let mut body = Map::new();
    body.insert("model".to_owned(), Value::String(model.to_owned()));
    body.insert("messages".to_owned(), messages.clone());
    body.insert("stream".to_owned(), Value::Bool(stream));
    body.insert("temperature".to_owned(), json!(TEMPERATURE));
    body.insert("seed".to_owned(), json!(SEED));
    body.insert("max_tokens".to_owned(), json!(MAX_TOKENS));
    if let Some(format) = response_format {
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
    if !url.username().is_empty() || url.password().is_some() {
        return Err("API root must not contain credentials".to_owned());
    }
    if url.query().is_some() || url.fragment().is_some() {
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

fn provider_error(error: OpenAIError) -> ProviderError {
    match error {
        OpenAIError::ApiError(response) => match response.status_code.as_u16() {
            401 | 403 => ProviderError::Authentication,
            429 => ProviderError::RateLimited,
            500..=599 => ProviderError::Server,
            _ => ProviderError::Response,
        },
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
#[derive(Deserialize)]
struct ChatResponse {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}
#[derive(Deserialize)]
struct ChatChoice {
    #[serde(default)]
    message: Option<ChatMessage>,
}
#[derive(Deserialize)]
struct ChatMessage {
    #[serde(default)]
    content: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    #[serde(default)]
    stream_ended_without_done_marker: bool,
}
#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: Option<ChatMessage>,
}
