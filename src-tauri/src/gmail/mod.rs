use std::{collections::HashMap, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::DateTime;
use reqwest::{Client, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use thiserror::Error;
use tokio::{sync::Mutex, time::Instant};

pub const PROFILE_COST: u32 = 1;
pub const LABELS_LIST_COST: u32 = 1;
pub const MESSAGES_LIST_COST: u32 = 5;
pub const MESSAGES_GET_COST: u32 = 5;
pub const MESSAGES_MODIFY_COST: u32 = 5;
pub const MESSAGES_BATCH_MODIFY_COST: u32 = 50;
pub const HISTORY_LIST_COST: u32 = 2;

const LIST_FIELDS: &str = "messages(id,threadId),nextPageToken,resultSizeEstimate";
const MESSAGE_FIELDS: &str = "id,threadId,historyId,labelIds,snippet,internalDate,payload(headers,body,parts,filename,mimeType,partId)";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Profile {
    pub email_address: String,
    pub messages_total: i64,
    pub threads_total: i64,
    pub history_id: i64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GmailLabel {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub message_count: i64,
    pub unread_count: i64,
    pub color: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageRef {
    pub id: String,
    pub thread_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_page_token: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlinePart {
    pub content_id: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GmailMessage {
    pub id: String,
    pub thread_id: String,
    pub history_id: i64,
    pub label_ids: Vec<String>,
    pub snippet: String,
    pub sent_at: i64,
    pub rfc_message_id: Option<String>,
    pub sender: String,
    pub recipients: String,
    pub subject: String,
    pub html_body: Option<String>,
    pub plain_body: Option<String>,
    pub has_attachments: bool,
    pub inline_parts: Vec<InlinePart>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryPage {
    pub history_id: i64,
    pub records: Vec<HistoryRecord>,
    pub next_page_token: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryRecord {
    pub id: i64,
    pub messages_added: Vec<MessageRef>,
    pub messages_deleted: Vec<MessageRef>,
    pub labels_added: Vec<LabelChange>,
    pub labels_removed: Vec<LabelChange>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LabelChange {
    pub message: MessageRef,
    pub label_ids: Vec<String>,
}

#[derive(Debug, Error)]
pub enum GmailError {
    #[error("expired Gmail history checkpoint")]
    HistoryExpired,
    #[error("Gmail request failed with status {0}")]
    Http(u16),
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("invalid Gmail response: {0}")]
    Response(#[from] serde_json::Error),
}

struct Bucket {
    state: Mutex<(f64, Instant)>,
}
impl Bucket {
    fn new() -> Self {
        Self {
            state: Mutex::new((250.0, Instant::now())),
        }
    }
    async fn acquire(&self, cost: u32) {
        loop {
            let wait = {
                let mut state = self.state.lock().await;
                let now = Instant::now();
                state.0 = (state.0 + (now - state.1).as_secs_f64() * 250.0).min(250.0);
                state.1 = now;
                if state.0 >= cost as f64 {
                    state.0 -= cost as f64;
                    None
                } else {
                    Some(Duration::from_secs_f64((cost as f64 - state.0) / 250.0))
                }
            };
            if let Some(wait) = wait {
                tokio::time::sleep(wait).await;
            } else {
                return;
            }
        }
    }
}

pub struct GmailClient {
    http: Client,
    base_url: String,
    access_token: String,
    bucket: Bucket,
}
impl GmailClient {
    pub fn new(access_token: impl Into<String>) -> Self {
        Self::with_base_url(access_token, "https://gmail.googleapis.com/gmail/v1")
    }
    pub fn with_base_url(access_token: impl Into<String>, base_url: impl Into<String>) -> Self {
        Self {
            http: Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            access_token: access_token.into(),
            bucket: Bucket::new(),
        }
    }
    pub async fn profile(&self) -> Result<Profile, GmailError> {
        let raw: RawProfile = self
            .get("/users/me/profile", &[], PROFILE_COST, false)
            .await?;
        Ok(Profile {
            email_address: raw.email_address,
            messages_total: raw.messages_total,
            threads_total: raw.threads_total,
            history_id: number(&raw.history_id),
        })
    }
    pub async fn labels(&self) -> Result<Vec<GmailLabel>, GmailError> {
        let raw: RawLabels = self
            .get("/users/me/labels", &[], LABELS_LIST_COST, false)
            .await?;
        Ok(raw
            .labels
            .into_iter()
            .map(|label| GmailLabel {
                id: label.id,
                name: label.name,
                kind: label
                    .kind
                    .unwrap_or_else(|| "user".into())
                    .to_ascii_lowercase(),
                message_count: label.messages_total.unwrap_or(0),
                unread_count: label.messages_unread.unwrap_or(0),
                color: label.color.and_then(|value| value.background_color),
            })
            .collect())
    }
    pub async fn list_messages_page(
        &self,
        label_ids: &[String],
        page_token: Option<&str>,
    ) -> Result<Page<MessageRef>, GmailError> {
        self.list_messages_page_matching(label_ids, None, page_token)
            .await
    }
    pub async fn list_all_messages(
        &self,
        label_ids: &[String],
    ) -> Result<Vec<MessageRef>, GmailError> {
        self.list_all_messages_matching(label_ids, None).await
    }
    /// Same as [`Self::list_messages_page`] but with an optional Gmail
    /// search `q` filter (e.g. `newer_than:30d`), used by initial/full sync
    /// to bound the first fetch to roughly the last 30 days.
    pub async fn list_messages_page_matching(
        &self,
        label_ids: &[String],
        query_filter: Option<&str>,
        page_token: Option<&str>,
    ) -> Result<Page<MessageRef>, GmailError> {
        let mut query = vec![("fields".to_owned(), LIST_FIELDS.to_owned())];
        for label in label_ids {
            query.push(("labelIds".to_owned(), label.clone()));
        }
        if let Some(filter) = query_filter {
            query.push(("q".to_owned(), filter.to_owned()));
        }
        if let Some(token) = page_token {
            query.push(("pageToken".to_owned(), token.into()));
        }
        let raw: RawMessageList = self
            .get("/users/me/messages", &query, MESSAGES_LIST_COST, false)
            .await?;
        Ok(Page {
            items: raw
                .messages
                .unwrap_or_default()
                .into_iter()
                .map(|message| MessageRef {
                    id: message.id,
                    thread_id: message.thread_id.unwrap_or_default(),
                })
                .collect(),
            next_page_token: raw.next_page_token,
        })
    }
    pub async fn list_all_messages_matching(
        &self,
        label_ids: &[String],
        query_filter: Option<&str>,
    ) -> Result<Vec<MessageRef>, GmailError> {
        let mut all = Vec::new();
        let mut token = None;
        loop {
            let page = self
                .list_messages_page_matching(label_ids, query_filter, token.as_deref())
                .await?;
            all.extend(page.items);
            if page.next_page_token.is_none() {
                return Ok(all);
            }
            token = page.next_page_token;
        }
    }
    pub async fn message(&self, id: &str) -> Result<GmailMessage, GmailError> {
        let raw: RawMessage = self
            .get(
                &format!("/users/me/messages/{id}"),
                &[("fields".to_owned(), MESSAGE_FIELDS.into())],
                MESSAGES_GET_COST,
                false,
            )
            .await?;
        Ok(map_message(raw))
    }
    pub async fn modify_message(
        &self,
        id: &str,
        add_label_ids: &[String],
        remove_label_ids: &[String],
    ) -> Result<GmailMessage, GmailError> {
        let raw: RawMessage = self
            .send(
                reqwest::Method::POST,
                &format!("/users/me/messages/{id}/modify"),
                &ModifyRequest {
                    add_label_ids,
                    remove_label_ids,
                },
                MESSAGES_MODIFY_COST,
                false,
            )
            .await?;
        Ok(map_message(raw))
    }
    pub async fn batch_modify(
        &self,
        ids: &[String],
        add_label_ids: &[String],
        remove_label_ids: &[String],
    ) -> Result<(), GmailError> {
        let _: serde_json::Value = self
            .send(
                reqwest::Method::POST,
                "/users/me/messages/batchModify",
                &BatchModifyRequest {
                    ids,
                    add_label_ids,
                    remove_label_ids,
                },
                MESSAGES_BATCH_MODIFY_COST,
                false,
            )
            .await?;
        Ok(())
    }
    pub async fn history_page(
        &self,
        start_history_id: i64,
        page_token: Option<&str>,
    ) -> Result<HistoryPage, GmailError> {
        let mut query = vec![("startHistoryId".to_owned(), start_history_id.to_string())];
        if let Some(token) = page_token {
            query.push(("pageToken".to_owned(), token.to_owned()));
        }
        let raw: RawHistory = self
            .get("/users/me/history", &query, HISTORY_LIST_COST, true)
            .await?;
        Ok(HistoryPage {
            history_id: number(&raw.history_id),
            records: raw
                .history
                .unwrap_or_default()
                .into_iter()
                .map(map_history)
                .collect(),
            next_page_token: raw.next_page_token,
        })
    }
    async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(String, String)],
        cost: u32,
        history: bool,
    ) -> Result<T, GmailError> {
        self.bucket.acquire(cost).await;
        self.request(
            reqwest::Method::GET,
            path,
            query
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
            Option::<&()>::None,
            history,
        )
        .await
    }
    async fn send<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: &B,
        cost: u32,
        history: bool,
    ) -> Result<T, GmailError> {
        self.bucket.acquire(cost).await;
        self.request(method, path, std::iter::empty(), Some(body), history)
            .await
    }
    async fn request<
        'a,
        T: DeserializeOwned,
        B: Serialize + ?Sized,
        I: IntoIterator<Item = (&'a str, &'a str)>,
    >(
        &self,
        method: reqwest::Method,
        path: &str,
        query: I,
        body: Option<&B>,
        history: bool,
    ) -> Result<T, GmailError> {
        let query = query.into_iter().collect::<Vec<_>>();
        for attempt in 0..10 {
            let mut request = self
                .http
                .request(method.clone(), format!("{}{}", self.base_url, path))
                .bearer_auth(&self.access_token)
                .query(&query);
            if let Some(body) = body {
                request = request.json(body);
            }
            match request.send().await {
                Ok(response) if response.status().is_success() => {
                    return Ok(response.json().await?)
                }
                Ok(response) => {
                    let status = response.status();
                    if history && status == StatusCode::NOT_FOUND {
                        return Err(GmailError::HistoryExpired);
                    }
                    if (status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error())
                        && attempt < 9
                    {
                        tokio::time::sleep(backoff(attempt + 1)).await;
                        continue;
                    }
                    return Err(GmailError::Http(status.as_u16()));
                }
                Err(error) if (error.is_connect() || error.is_timeout()) && attempt < 9 => {
                    tokio::time::sleep(backoff(attempt + 1)).await
                }
                Err(error) => return Err(GmailError::Network(error)),
            }
        }
        unreachable!("retry loop returns")
    }
}

pub fn backoff(attempt: u8) -> Duration {
    Duration::from_secs(1_u64 << attempt.saturating_sub(1).min(5))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawProfile {
    email_address: String,
    messages_total: i64,
    threads_total: i64,
    history_id: String,
}
#[derive(Deserialize)]
struct RawLabels {
    labels: Vec<RawLabel>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLabel {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: Option<String>,
    messages_total: Option<i64>,
    messages_unread: Option<i64>,
    color: Option<RawColor>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawColor {
    background_color: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMessageList {
    messages: Option<Vec<RawRef>>,
    next_page_token: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRef {
    id: String,
    thread_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMessage {
    id: String,
    thread_id: String,
    history_id: String,
    label_ids: Option<Vec<String>>,
    snippet: Option<String>,
    internal_date: Option<String>,
    payload: RawPart,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPart {
    mime_type: Option<String>,
    filename: Option<String>,
    headers: Option<Vec<RawHeader>>,
    body: Option<RawBody>,
    parts: Option<Vec<RawPart>>,
}
#[derive(Deserialize)]
struct RawHeader {
    name: String,
    value: String,
}
#[derive(Deserialize)]
struct RawBody {
    data: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModifyRequest<'a> {
    add_label_ids: &'a [String],
    remove_label_ids: &'a [String],
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchModifyRequest<'a> {
    ids: &'a [String],
    add_label_ids: &'a [String],
    remove_label_ids: &'a [String],
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawHistory {
    history_id: String,
    history: Option<Vec<RawHistoryRecord>>,
    next_page_token: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawHistoryRecord {
    id: String,
    messages_added: Option<Vec<RawHistoryMessage>>,
    messages_deleted: Option<Vec<RawHistoryMessage>>,
    labels_added: Option<Vec<RawLabelChange>>,
    labels_removed: Option<Vec<RawLabelChange>>,
}
#[derive(Deserialize)]
struct RawHistoryMessage {
    message: RawRef,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLabelChange {
    message: RawRef,
    label_ids: Vec<String>,
}

fn map_message(raw: RawMessage) -> GmailMessage {
    let headers = headers(raw.payload.headers.as_deref().unwrap_or_default());
    let mut content = Content::default();
    collect_part(&raw.payload, &mut content);
    GmailMessage {
        id: raw.id,
        thread_id: raw.thread_id,
        history_id: number(&raw.history_id),
        label_ids: raw.label_ids.unwrap_or_default(),
        snippet: raw.snippet.unwrap_or_default(),
        sent_at: raw
            .internal_date
            .as_deref()
            .and_then(|value| value.parse::<i64>().ok())
            .map(|value| value / 1000)
            .or_else(|| {
                headers
                    .get("date")
                    .and_then(|value| DateTime::parse_from_rfc2822(value).ok())
                    .map(|value| value.timestamp())
            })
            .unwrap_or_default(),
        rfc_message_id: headers.get("message-id").cloned(),
        sender: headers.get("from").cloned().unwrap_or_default(),
        recipients: ["to", "cc", "bcc"]
            .iter()
            .filter_map(|key| headers.get(*key))
            .cloned()
            .collect::<Vec<_>>()
            .join(", "),
        subject: headers.get("subject").cloned().unwrap_or_default(),
        html_body: content.html,
        plain_body: content.plain,
        has_attachments: content.attachments,
        inline_parts: content.inline,
    }
}
#[derive(Default)]
struct Content {
    html: Option<String>,
    plain: Option<String>,
    attachments: bool,
    inline: Vec<InlinePart>,
}
fn collect_part(part: &RawPart, content: &mut Content) {
    let mime = part
        .mime_type
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let data = part
        .body
        .as_ref()
        .and_then(|body| body.data.as_deref())
        .and_then(decode);
    let cid = part.headers.as_deref().and_then(|headers| {
        headers
            .iter()
            .find(|header| header.name.eq_ignore_ascii_case("content-id"))
            .map(|header| header.value.trim_matches(['<', '>']).to_owned())
    });
    if !part.filename.as_deref().unwrap_or_default().is_empty() {
        content.attachments = true;
    }
    if let (Some(content_id), Some(bytes)) = (cid, data.clone()) {
        content.inline.push(InlinePart {
            content_id,
            mime_type: mime.clone(),
            bytes,
        });
    }
    if mime.starts_with("text/html") {
        content.html = data.map(bytes_to_text);
    } else if mime.starts_with("text/plain") {
        content.plain = data.map(bytes_to_text);
    }
    if let Some(parts) = &part.parts {
        for child in parts {
            collect_part(child, content);
        }
    }
}
fn decode(value: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value.trim_end_matches('=').as_bytes())
        .ok()
}
fn bytes_to_text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}
fn headers(values: &[RawHeader]) -> HashMap<String, String> {
    values
        .iter()
        .map(|header| (header.name.to_ascii_lowercase(), header.value.clone()))
        .collect()
}
fn number(value: &str) -> i64 {
    value.parse().unwrap_or_default()
}
fn map_history(value: RawHistoryRecord) -> HistoryRecord {
    let refs = |items: Option<Vec<RawHistoryMessage>>| {
        items
            .unwrap_or_default()
            .into_iter()
            .map(|item| MessageRef {
                id: item.message.id,
                thread_id: item.message.thread_id.unwrap_or_default(),
            })
            .collect()
    };
    let changes = |items: Option<Vec<RawLabelChange>>| {
        items
            .unwrap_or_default()
            .into_iter()
            .map(|item| LabelChange {
                message: MessageRef {
                    id: item.message.id,
                    thread_id: item.message.thread_id.unwrap_or_default(),
                },
                label_ids: item.label_ids,
            })
            .collect()
    };
    HistoryRecord {
        id: number(&value.id),
        messages_added: refs(value.messages_added),
        messages_deleted: refs(value.messages_deleted),
        labels_added: changes(value.labels_added),
        labels_removed: changes(value.labels_removed),
    }
}
