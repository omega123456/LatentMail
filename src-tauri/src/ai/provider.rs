use reqwest::Client;
use serde::{Deserialize, Serialize};
use thiserror::Error;
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
