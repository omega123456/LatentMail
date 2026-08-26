use std::sync::atomic::{AtomicBool, Ordering};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

const FRAME_SEPARATOR: &str = "\n\n";
const DATA_PREFIX: &str = "data:";
const DONE_MARKER: &str = "[DONE]";

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

#[derive(Clone)]
pub struct Provider {
    client: Client,
    base_url: Url,
    api_key: Option<String>,
}

impl Provider {
    pub fn new(base_url: &str, api_key: Option<String>) -> Result<Self, String> {
        Ok(Self {
            client: Client::new(),
            base_url: api_root(base_url)?,
            api_key,
        })
    }
    pub async fn models(&self) -> Result<Vec<ProviderModel>, ProviderError> {
        let response: ModelsResponse = self
            .get("models")
            .send()
            .await
            .map_err(provider_error)?
            .error_for_status()
            .map_err(provider_error)?
            .json()
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
            .post("embeddings")
            .json(&serde_json::json!({"model":model,"input":input}))
            .send()
            .await
            .map_err(provider_error)?
            .error_for_status()
            .map_err(provider_error)?
            .json()
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
        messages: serde_json::Value,
    ) -> Result<String, ProviderError> {
        let response: ChatResponse = self
            .post("chat/completions")
            .json(&serde_json::json!({"model":model,"messages":messages}))
            .send()
            .await
            .map_err(provider_error)?
            .error_for_status()
            .map_err(provider_error)?
            .json()
            .await
            .map_err(provider_error)?;
        response
            .choices
            .into_iter()
            .find_map(|choice| choice.message.and_then(|message| message.content))
            .ok_or(ProviderError::Response)
    }
    pub async fn chat_completion_stream(
        &self,
        model: &str,
        messages: serde_json::Value,
        cancel: &AtomicBool,
        on_delta: &mut (dyn FnMut(&str) + Send),
    ) -> Result<(), ProviderError> {
        let mut response = self
            .post("chat/completions")
            .json(&serde_json::json!({"model":model,"messages":messages,"stream":true}))
            .send()
            .await
            .map_err(provider_error)?
            .error_for_status()
            .map_err(provider_error)?;
        let mut buffer = String::new();
        let mut completed = false;
        while let Some(chunk) = response.chunk().await.map_err(provider_error)? {
            if cancel.load(Ordering::SeqCst) {
                return Ok(());
            }
            buffer.push_str(&String::from_utf8_lossy(&chunk).replace('\r', ""));
            while let Some(offset) = buffer.find(FRAME_SEPARATOR) {
                if cancel.load(Ordering::SeqCst) {
                    return Ok(());
                }
                let frame = buffer[..offset].to_owned();
                buffer.replace_range(..offset + FRAME_SEPARATOR.len(), "");
                match read_frame(&frame)? {
                    Frame::Delta(text) => on_delta(&text),
                    Frame::Done => completed = true,
                    Frame::Ignored => {}
                }
            }
        }
        if completed {
            Ok(())
        } else {
            Err(ProviderError::Response)
        }
    }
    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.authorized(
            self.client
                .get(self.base_url.join(path).expect("relative provider path")),
        )
    }
    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.authorized(
            self.client
                .post(self.base_url.join(path).expect("relative provider path")),
        )
    }
    fn authorized(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(key) => request.bearer_auth(key),
            None => request,
        }
    }
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
enum Frame {
    Delta(String),
    Done,
    Ignored,
}

fn read_frame(frame: &str) -> Result<Frame, ProviderError> {
    let mut outcome = Frame::Ignored;
    for line in frame.lines() {
        let Some(payload) = line.trim().strip_prefix(DATA_PREFIX) else {
            continue;
        };
        let payload = payload.trim();
        if payload == DONE_MARKER {
            return Ok(Frame::Done);
        }
        let parsed: StreamChunk =
            serde_json::from_str(payload).map_err(|_| ProviderError::Response)?;
        if let Some(text) = parsed
            .choices
            .into_iter()
            .find_map(|choice| choice.delta.and_then(|delta| delta.content))
            .filter(|text| !text.is_empty())
        {
            outcome = Frame::Delta(text);
        }
    }
    Ok(outcome)
}
fn provider_error(error: reqwest::Error) -> ProviderError {
    match error.status().map(|status| status.as_u16()) {
        Some(401 | 403) => ProviderError::Authentication,
        Some(429) => ProviderError::RateLimited,
        Some(500..=599) => ProviderError::Server,
        Some(_) => ProviderError::Response,
        None => ProviderError::Transport,
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
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
}
#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: Option<ChatMessage>,
}
