use std::{sync::Arc, time::Duration};

use reqwest::{Client, StatusCode};
use serde::{de::DeserializeOwned, Serialize};

use super::rate_limit::AccountBuckets;
use super::wire::{DraftUpload, DraftUploadMessage, RawId};
use super::{
    AccountClientConfig, GmailError, GmailRateLimiters, QuotaClass, GMAIL_API_PATH,
    GMAIL_UPLOAD_PATH, HTTP_CLIENT, LAST_RETRYABLE_ATTEMPT, MAX_BACKOFF_EXPONENT,
    MAX_GMAIL_RESPONSE_BYTES, MAX_REQUEST_ATTEMPTS, MULTIPART_FRAMING_BYTES,
};

mod account;
mod drafts;
mod messages;

pub(super) struct GetRequest<'a> {
    pub(super) path: &'a str,
    pub(super) query: &'a [(String, String)],
    pub(super) cost: u32,
    pub(super) history: bool,
}

pub(super) struct SendRequest<'a, B: ?Sized> {
    pub(super) method: reqwest::Method,
    pub(super) path: &'a str,
    pub(super) body: &'a B,
    pub(super) cost: u32,
    pub(super) history: bool,
}

pub(super) struct ApiRequest<'a, B: ?Sized> {
    pub(super) method: reqwest::Method,
    pub(super) path: &'a str,
    pub(super) query: Vec<(&'a str, &'a str)>,
    pub(super) body: Option<&'a B>,
    pub(super) history: bool,
}

pub(super) struct DraftUploadRequest<'a> {
    pub(super) method: reqwest::Method,
    pub(super) path: &'a str,
    pub(super) raw: &'a [u8],
    pub(super) thread_id: Option<&'a str>,
    pub(super) cost: u32,
}

struct AttemptSpec<'a, B: ?Sized> {
    request: &'a ApiRequest<'a, B>,
    attempt: u8,
    max_bytes: usize,
}

enum AttemptOutcome<T> {
    Done(Result<T, GmailError>),
    Retry(Duration),
}

struct HttpFailure<'a> {
    pub(super) method: &'a reqwest::Method,
    pub(super) path: &'a str,
    pub(super) status: StatusCode,
    pub(super) body: &'a str,
}

#[derive(Clone)]
pub struct GmailClient {
    pub(super) http: Client,
    pub(super) base_url: String,
    pub(super) access_token: String,
    pub(super) buckets: Arc<AccountBuckets>,
    pub(super) quota_class: QuotaClass,
}

impl GmailClient {
    pub fn with_base_url(access_token: impl Into<String>, base_url: impl Into<String>) -> Self {
        Self {
            http: HTTP_CLIENT.clone(),
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            access_token: access_token.into(),
            buckets: Arc::new(AccountBuckets::new()),
            quota_class: QuotaClass::Standard,
        }
    }
    pub async fn for_account(
        config: AccountClientConfig<'_>,
        limiters: &GmailRateLimiters,
    ) -> Self {
        let mut client = Self::with_base_url(config.access_token, config.base_url);
        client.buckets = limiters.for_account(config.account_id).await;
        client
    }

    pub fn traversal_scoped(&self) -> Self {
        let mut client = self.clone();
        client.quota_class = QuotaClass::Traversal;
        client
    }
    pub(super) async fn acquire(&self, cost: u32) {
        if self.quota_class == QuotaClass::Traversal {
            self.buckets.traversal.acquire(cost).await;
        }
        self.buckets.shared.acquire(cost).await;
    }
    pub(super) async fn get<T: DeserializeOwned>(
        &self,
        spec: GetRequest<'_>,
    ) -> Result<T, GmailError> {
        self.acquire(spec.cost).await;
        self.request(ApiRequest {
            method: reqwest::Method::GET,
            path: spec.path,
            query: spec
                .query
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect(),
            body: Option::<&()>::None,
            history: spec.history,
        })
        .await
    }
    pub(super) async fn get_list_page<T: DeserializeOwned + Default>(
        &self,
        spec: GetRequest<'_>,
    ) -> Result<T, GmailError> {
        let page: Option<T> = self.get(spec).await?;
        Ok(page.unwrap_or_default())
    }
    pub(super) async fn send<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        spec: SendRequest<'_, B>,
    ) -> Result<T, GmailError> {
        self.acquire(spec.cost).await;
        self.request(ApiRequest {
            method: spec.method,
            path: spec.path,
            query: Vec::new(),
            body: Some(spec.body),
            history: spec.history,
        })
        .await
    }
    pub(super) async fn request<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        spec: ApiRequest<'_, B>,
    ) -> Result<T, GmailError> {
        self.request_capped(spec, MAX_GMAIL_RESPONSE_BYTES).await
    }
    pub(super) async fn request_capped<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        spec: ApiRequest<'_, B>,
        max_bytes: usize,
    ) -> Result<T, GmailError> {
        for attempt in 0..MAX_REQUEST_ATTEMPTS {
            match self
                .execute_attempt(AttemptSpec {
                    request: &spec,
                    attempt: attempt,
                    max_bytes: max_bytes,
                })
                .await
            {
                AttemptOutcome::Done(result) => return result,
                AttemptOutcome::Retry(delay) => tokio::time::sleep(delay).await,
            }
        }
        unreachable!("retry loop returns")
    }

    async fn execute_attempt<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        spec: AttemptSpec<'_, B>,
    ) -> AttemptOutcome<T> {
        let request = self.build_request(spec.request);
        match request.send().await {
            Ok(response) => handle_response(response, spec).await,
            Err(error) => handle_network_error(error, spec.attempt),
        }
    }

    fn build_request<B: Serialize + ?Sized>(
        &self,
        spec: &ApiRequest<'_, B>,
    ) -> reqwest::RequestBuilder {
        let request = self
            .http
            .request(
                spec.method.clone(),
                format!("{}{}", self.base_url, spec.path),
            )
            .bearer_auth(&self.access_token)
            .query(&spec.query);
        if let Some(body) = spec.body {
            return request.json(body);
        }
        request
    }
    pub(super) async fn upload_draft(
        &self,
        spec: DraftUploadRequest<'_>,
    ) -> Result<String, GmailError> {
        self.acquire(spec.cost).await;

        let boundary = crate::compose::drafts::generate_id("latentmail-part");
        let metadata = serde_json::to_vec(&DraftUpload {
            message: DraftUploadMessage {
                thread_id: spec.thread_id,
            },
        })?;
        let mut body =
            Vec::with_capacity(spec.raw.len() + metadata.len() + MULTIPART_FRAMING_BYTES);
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n")
                .as_bytes(),
        );
        body.extend_from_slice(&metadata);
        body.extend_from_slice(
            format!("\r\n--{boundary}\r\nContent-Type: message/rfc822\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(spec.raw);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let request = self
            .http
            .request(
                spec.method,
                format!("{}{}", upload_base(&self.base_url), spec.path),
            )
            .bearer_auth(&self.access_token)
            .query(&[("uploadType", "multipart")])
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/related; boundary={boundary}"),
            )
            .body(body);
        let response = request.send().await?;
        if !response.status().is_success() {
            let status = response.status();
            tracing::error!(
                target: "gmail",
                "draft upload {} failed: {status} {}",
                spec.path,
                response.text().await.unwrap_or_default()
            );
            return Err(GmailError::Http(status.as_u16()));
        }
        let raw: RawId = response.json().await?;
        Ok(raw.id)
    }
}

async fn handle_response<T: DeserializeOwned, B: Serialize + ?Sized>(
    response: reqwest::Response,
    spec: AttemptSpec<'_, B>,
) -> AttemptOutcome<T> {
    if response.status().is_success() {
        return AttemptOutcome::Done(decode_success_response(response, spec.max_bytes).await);
    }
    handle_error_response(response, spec.request, spec.attempt).await
}

async fn decode_success_response<T: DeserializeOwned>(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<T, GmailError> {
    let too_large = response
        .content_length()
        .is_some_and(|len| len > max_bytes as u64);
    if too_large {
        return Err(GmailError::ResponseTooLarge);
    }
    let raw = response.bytes().await?;
    let body = response_json_bytes(&raw);
    Ok(serde_json::from_slice(body)?)
}

async fn handle_error_response<T, B: ?Sized>(
    response: reqwest::Response,
    request: &ApiRequest<'_, B>,
    attempt: u8,
) -> AttemptOutcome<T> {
    let status = response.status();
    if request.history && status == StatusCode::NOT_FOUND {
        return AttemptOutcome::Done(Err(GmailError::HistoryExpired));
    }
    let can_retry = crate::is_retryable_status(status.as_u16()) && attempt < LAST_RETRYABLE_ATTEMPT;
    if can_retry {
        return AttemptOutcome::Retry(backoff(attempt + 1));
    }
    let body = response.text().await.unwrap_or_default();
    log_http_failure(HttpFailure {
        method: &request.method,
        path: request.path,
        status: status,
        body: &body,
    });
    AttemptOutcome::Done(Err(GmailError::Http(status.as_u16())))
}

fn handle_network_error<T>(error: reqwest::Error, attempt: u8) -> AttemptOutcome<T> {
    let can_retry = (error.is_connect() || error.is_timeout()) && attempt < LAST_RETRYABLE_ATTEMPT;
    if can_retry {
        return AttemptOutcome::Retry(backoff(attempt + 1));
    }
    AttemptOutcome::Done(Err(GmailError::Network(error)))
}

fn response_json_bytes(raw: &[u8]) -> &[u8] {
    if raw.is_empty() {
        return b"null";
    }
    raw
}

fn log_http_failure(failure: HttpFailure<'_>) {
    if failure.status == StatusCode::NOT_FOUND {
        tracing::debug!(
            target: "gmail",
            "{} {}: {} {}",
            failure.method,
            failure.path,
            failure.status,
            failure.body
        );
        return;
    }
    tracing::error!(
        target: "gmail",
        "{} {} failed: {} {}",
        failure.method,
        failure.path,
        failure.status,
        failure.body
    );
}

fn upload_base(base: &str) -> String {
    base.strip_suffix(GMAIL_API_PATH).map_or_else(
        || format!("{base}{GMAIL_UPLOAD_PATH}"),
        |prefix| format!("{prefix}{GMAIL_UPLOAD_PATH}"),
    )
}

pub fn backoff(attempt: u8) -> Duration {
    Duration::from_secs(1_u64 << attempt.saturating_sub(1).min(MAX_BACKOFF_EXPONENT))
}
