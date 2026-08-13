use std::{collections::HashMap, sync::Arc, time::Duration};

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
// Label lifecycle and draft-deletion endpoint costs (Phase 3). Declared
// here alongside the rest so `gmail::labels` references, rather than
// duplicates, a single source of truth — matching every write endpoint
// above at Gmail's standard per-write cost.
pub const LABELS_CREATE_COST: u32 = 5;
pub const LABELS_UPDATE_COST: u32 = 5;
pub const LABELS_DELETE_COST: u32 = 5;
pub const DRAFTS_DELETE_COST: u32 = 5;
/// Cost of `GET /users/me/drafts` — used to resolve a message id to Gmail's
/// own, distinct draft id (see [`GmailClient::list_draft_ids`]).
pub const DRAFTS_LIST_COST: u32 = 5;
pub const DRAFTS_CREATE_COST: u32 = 5;
pub const DRAFTS_UPDATE_COST: u32 = 5;
pub const DRAFTS_GET_COST: u32 = 5;
pub const MESSAGES_SEND_COST: u32 = 5;
pub const ATTACHMENTS_GET_COST: u32 = 5;

/// Gmail's own default listing page size — applies whenever a caller
/// doesn't request one explicitly. The maximum is 500.
pub const DEFAULT_PAGE_SIZE: u32 = 100;
pub const MAX_PAGE_SIZE: u32 = 500;

const LIST_FIELDS: &str = "messages(id,threadId),nextPageToken";
const MESSAGE_FIELDS: &str = "id,threadId,historyId,labelIds,snippet,internalDate,payload(headers,body,parts,filename,mimeType,partId)";

pub mod labels;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Profile {
    pub email_address: String,
    pub messages_total: i64,
    pub threads_total: i64,
    pub history_id: i64,
}
/// Gmail's text/background colour pair for a user label (D10). The palette
/// of valid pairs lives in [`labels::LABEL_PALETTE`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LabelColorPair {
    pub text_color: String,
    pub background_color: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GmailLabel {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub message_count: i64,
    pub unread_count: i64,
    pub color: Option<LabelColorPair>,
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
/// Listing options every enumeration call now takes explicitly (Phase 3):
/// whether to include Spam and Trash (excluded by default) and the page
/// size to request (Gmail defaults to 100, capped at [`MAX_PAGE_SIZE`]).
/// Backfill/reconciliation (Phase 4/5) always set both; ordinary listing
/// keeps [`ListOptions::default`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListOptions {
    pub include_spam_and_trash: bool,
    pub page_size: u32,
}
impl Default for ListOptions {
    fn default() -> Self {
        Self {
            include_spam_and_trash: false,
            page_size: DEFAULT_PAGE_SIZE,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlinePart {
    pub content_id: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachmentPart {
    pub attachment_id: String,
    pub filename: String,
    pub mime_type: String,
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
    pub to_recipients: String,
    pub cc_recipients: String,
    pub bcc_recipients: String,
    pub rfc_references: Option<String>,
    pub subject: String,
    pub html_body: Option<String>,
    pub plain_body: Option<String>,
    pub has_attachments: bool,
    pub inline_parts: Vec<InlinePart>,
    pub attachment_parts: Vec<AttachmentPart>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GmailDraft {
    pub id: String,
    pub message: GmailMessage,
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
    #[error("invalid Gmail attachment payload")]
    AttachmentData,
}

/// The account-wide sustained Gmail quota, conservatively calibrated per
/// D9: Google's published per-user limit disagrees across sources (6,000 or
/// 15,000 units/minute), so pacing takes the lower, conservative figure —
/// under-consuming costs throughput, over-consuming produces sustained
/// rate-limit responses. Replaces the previous hard-coded 250/sec.
pub const ACCOUNT_RATE_PER_SECOND: f64 = 100.0;

/// The fixed share of the account's quota available to traversal-class work
/// (whole-mailbox backfill/reconciliation). Traversal is capped at this
/// share so a saturating traversal can never starve non-traversal work —
/// interactive actions, polling and body fetches — which stays uncapped and
/// draws from the whole account budget (see D4).
pub const TRAVERSAL_SHARE: f64 = 0.4;

/// Which quota class a [`GmailClient`] draws from. Traversal-class requests
/// additionally pass through a capped, class-scoped bucket before drawing
/// from the same account-wide bucket every other request uses — see
/// [`GmailClient::traversal_scoped`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QuotaClass {
    Standard,
    Traversal,
}

struct Bucket {
    state: Mutex<(f64, Instant)>,
    rate: f64,
    capacity: f64,
}
impl Bucket {
    fn new(rate: f64, capacity: f64) -> Self {
        Self {
            state: Mutex::new((capacity, Instant::now())),
            rate,
            capacity,
        }
    }
    async fn acquire(&self, cost: u32) {
        let cost = cost as f64;
        loop {
            let wait = {
                let mut state = self.state.lock().await;
                let now = Instant::now();
                state.0 = (state.0 + (now - state.1).as_secs_f64() * self.rate).min(self.capacity);
                state.1 = now;
                if state.0 >= cost {
                    state.0 -= cost;
                    None
                } else {
                    Some(Duration::from_secs_f64((cost - state.0) / self.rate))
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

/// Per-account bucket pair: `shared` paces every request against the whole
/// account budget; `traversal` additionally paces traversal-class requests
/// against their capped share. Traversal always draws from both, so its
/// consumption is still accounted against the shared total.
struct AccountBuckets {
    shared: Bucket,
    traversal: Bucket,
}
impl AccountBuckets {
    fn new() -> Self {
        Self {
            shared: Bucket::new(ACCOUNT_RATE_PER_SECOND, ACCOUNT_RATE_PER_SECOND),
            traversal: Bucket::new(
                ACCOUNT_RATE_PER_SECOND * TRAVERSAL_SHARE,
                ACCOUNT_RATE_PER_SECOND * TRAVERSAL_SHARE,
            ),
        }
    }
}

#[derive(Default)]
pub struct GmailRateLimiters {
    accounts: Mutex<HashMap<String, Arc<AccountBuckets>>>,
}
impl GmailRateLimiters {
    async fn for_account(&self, account_id: &str) -> Arc<AccountBuckets> {
        let mut accounts = self.accounts.lock().await;
        Arc::clone(
            accounts
                .entry(account_id.to_owned())
                .or_insert_with(|| Arc::new(AccountBuckets::new())),
        )
    }
}

#[derive(Clone)]
pub struct GmailClient {
    http: Client,
    base_url: String,
    access_token: String,
    buckets: Arc<AccountBuckets>,
    quota_class: QuotaClass,
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
            buckets: Arc::new(AccountBuckets::new()),
            quota_class: QuotaClass::Standard,
        }
    }
    pub async fn for_account(
        account_id: &str,
        access_token: impl Into<String>,
        base_url: impl Into<String>,
        limiters: &GmailRateLimiters,
    ) -> Self {
        let mut client = Self::with_base_url(access_token, base_url);
        client.buckets = limiters.for_account(account_id).await;
        client
    }
    /// A client that shares this one's account-wide limiter (existing call
    /// sites are unchanged — see D4) but is tagged traversal-class, so its
    /// requests are additionally capped at [`TRAVERSAL_SHARE`] of the
    /// account's rate. Non-traversal work never calls this and stays
    /// uncapped.
    pub fn traversal_scoped(&self) -> Self {
        let mut client = self.clone();
        client.quota_class = QuotaClass::Traversal;
        client
    }
    async fn acquire(&self, cost: u32) {
        if self.quota_class == QuotaClass::Traversal {
            self.buckets.traversal.acquire(cost).await;
        }
        self.buckets.shared.acquire(cost).await;
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
                color: label.color.and_then(|value| {
                    match (value.text_color, value.background_color) {
                        (Some(text_color), Some(background_color)) => Some(LabelColorPair {
                            text_color,
                            background_color,
                        }),
                        _ => None,
                    }
                }),
            })
            .collect())
    }
    pub async fn list_messages_page(
        &self,
        label_ids: &[String],
        page_token: Option<&str>,
    ) -> Result<Page<MessageRef>, GmailError> {
        self.list_messages_page_matching(label_ids, None, page_token, ListOptions::default())
            .await
    }
    pub async fn list_all_messages(
        &self,
        label_ids: &[String],
    ) -> Result<Vec<MessageRef>, GmailError> {
        self.list_all_messages_matching(label_ids, None, ListOptions::default())
            .await
    }
    /// Same as [`Self::list_messages_page`] but with an optional Gmail
    /// search `q` filter (e.g. `newer_than:30d`), used by initial/full sync
    /// to bound the first fetch to roughly the last 30 days, plus explicit
    /// [`ListOptions`] — Spam/Trash inclusion and an explicit page size
    /// (Gmail defaults to 100 and excludes Spam/Trash unless asked).
    pub async fn list_messages_page_matching(
        &self,
        label_ids: &[String],
        query_filter: Option<&str>,
        page_token: Option<&str>,
        options: ListOptions,
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
        if options.include_spam_and_trash {
            query.push(("includeSpamTrash".to_owned(), "true".to_owned()));
        }
        query.push((
            "maxResults".to_owned(),
            options.page_size.min(MAX_PAGE_SIZE).to_string(),
        ));
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
        options: ListOptions,
    ) -> Result<Vec<MessageRef>, GmailError> {
        let mut all = Vec::new();
        let mut token = None;
        loop {
            let page = self
                .list_messages_page_matching(label_ids, query_filter, token.as_deref(), options)
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
    /// Returns the stable draft id. Gmail answers a draft *write* with a
    /// minimal resource — `{"id", "message": {"id", "threadId", "labelIds"}}`,
    /// with no `historyId` and no `payload` — so a caller that needs the
    /// message itself re-reads it through [`GmailClient::draft`], which is
    /// the only draft route that returns a complete one.
    /// [`GmailClient::message`], but `None` when Gmail no longer has the id.
    /// A message can disappear between being enumerated (listed, or reported
    /// by history) and being fetched — promoting a draft to a sent message
    /// leaves exactly that behind, and so does any concurrent delete — so an
    /// enumerating caller must skip the id rather than abort its whole run.
    /// Callers acting on one specific message (a body fetch, a mutation
    /// write-back) want the 404 instead and keep using `message`.
    pub async fn message_if_present(&self, id: &str) -> Result<Option<GmailMessage>, GmailError> {
        match self.message(id).await {
            Err(GmailError::Http(404)) => Ok(None),
            other => other.map(Some),
        }
    }
    pub async fn create_draft(
        &self,
        raw: &[u8],
        thread_id: Option<&str>,
    ) -> Result<String, GmailError> {
        self.upload_draft(
            reqwest::Method::POST,
            "/users/me/drafts",
            raw,
            thread_id,
            DRAFTS_CREATE_COST,
        )
        .await
    }
    /// Returns the stable draft id — see [`GmailClient::create_draft`] for
    /// why a write never carries the message back.
    pub async fn update_draft(
        &self,
        draft_id: &str,
        raw: &[u8],
        thread_id: Option<&str>,
    ) -> Result<String, GmailError> {
        self.upload_draft(
            reqwest::Method::PUT,
            &format!("/users/me/drafts/{draft_id}"),
            raw,
            thread_id,
            DRAFTS_UPDATE_COST,
        )
        .await
    }
    pub async fn draft(&self, draft_id: &str) -> Result<GmailDraft, GmailError> {
        let raw: RawDraft = self
            .get(
                &format!("/users/me/drafts/{draft_id}"),
                &[("format".into(), "full".into())],
                DRAFTS_GET_COST,
                false,
            )
            .await?;
        Ok(GmailDraft {
            id: raw.id,
            message: map_message(raw.message.into_raw()?),
        })
    }
    /// Promotes the draft and returns the sent message's id. Promotion, like
    /// every other draft write, answers with a partial Message (id, thread,
    /// labels only), so the full message comes from [`GmailClient::message`].
    pub async fn send_draft(&self, draft_id: &str) -> Result<String, GmailError> {
        let raw: RawId = self
            .send(
                reqwest::Method::POST,
                "/users/me/drafts/send",
                &SendDraftRequest { id: draft_id },
                MESSAGES_SEND_COST,
                false,
            )
            .await?;
        Ok(raw.id)
    }
    pub async fn attachment(
        &self,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<Vec<u8>, GmailError> {
        let raw: RawAttachment = self
            .get(
                &format!("/users/me/messages/{message_id}/attachments/{attachment_id}"),
                &[],
                ATTACHMENTS_GET_COST,
                false,
            )
            .await?;
        decode(&raw.data).ok_or(GmailError::AttachmentData)
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
    /// Resolves every draft's Gmail message id to its own, *distinct* draft
    /// id (`GET /users/me/drafts/{id}` is a different resource from
    /// `GET /users/me/messages/{id}` — nothing about a message id is a valid
    /// draft id). Callers that need the draft id for exactly one message
    /// still have to page through the whole list — Gmail's API offers no
    /// "look up the draft for this message id" endpoint.
    pub async fn list_draft_ids(&self) -> Result<HashMap<String, String>, GmailError> {
        let mut mapping = HashMap::new();
        let mut token: Option<String> = None;
        loop {
            let mut query = vec![(
                "fields".to_owned(),
                "drafts(id,message/id),nextPageToken".to_owned(),
            )];
            if let Some(token) = &token {
                query.push(("pageToken".to_owned(), token.clone()));
            }
            let raw: RawDraftList = self
                .get("/users/me/drafts", &query, DRAFTS_LIST_COST, false)
                .await?;
            for draft in raw.drafts.unwrap_or_default() {
                mapping.insert(draft.message.id, draft.id);
            }
            if raw.next_page_token.is_none() {
                return Ok(mapping);
            }
            token = raw.next_page_token;
        }
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
        self.acquire(cost).await;
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
        self.acquire(cost).await;
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
                    // Write endpoints (`batchModify`) answer 204 with an empty
                    // body, which is not valid JSON — read it as `null` so the
                    // caller's `T` still deserializes.
                    let raw = response.bytes().await?;
                    let body: &[u8] = if raw.is_empty() { b"null" } else { &raw };
                    return Ok(serde_json::from_slice(body)?);
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
                    // Gmail explains every 4xx in its body ("Invalid JSON
                    // payload", "Precondition check failed", ...); a bare
                    // status code is not diagnosable on its own. A 404 is
                    // routine rather than a fault — an entity can vanish
                    // between being enumerated and being fetched — so the
                    // caller decides whether it matters (see
                    // [`GmailClient::message_if_present`]) and this only
                    // leaves a debug trace.
                    let body = response.text().await.unwrap_or_default();
                    if status == StatusCode::NOT_FOUND {
                        tracing::debug!(target: "gmail", "{method} {path}: {status} {body}");
                    } else {
                        tracing::error!(target: "gmail", "{method} {path} failed: {status} {body}");
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
    async fn upload_draft(
        &self,
        method: reqwest::Method,
        path: &str,
        raw: &[u8],
        thread_id: Option<&str>,
        cost: u32,
    ) -> Result<String, GmailError> {
        self.acquire(cost).await;
        // Gmail's upload endpoints take a `multipart/related` document —
        // the Draft resource as JSON, then the RFC822 bytes verbatim — and
        // require `uploadType`. A plain JSON body here (or one carrying
        // `raw`/`threadId` at the top level rather than under `message`) is
        // rejected with 400 before the message is ever assembled.
        let boundary = crate::compose::drafts::generate_id("latentmail-part");
        let metadata = serde_json::to_vec(&DraftUpload {
            message: DraftUploadMessage { thread_id },
        })?;
        let mut body = Vec::with_capacity(raw.len() + metadata.len() + 256);
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n")
                .as_bytes(),
        );
        body.extend_from_slice(&metadata);
        body.extend_from_slice(
            format!("\r\n--{boundary}\r\nContent-Type: message/rfc822\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(raw);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let request = self
            .http
            .request(method, format!("{}{}", upload_base(&self.base_url), path))
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
                "draft upload {path} failed: {status} {}",
                response.text().await.unwrap_or_default()
            );
            return Err(GmailError::Http(status.as_u16()));
        }
        let raw: RawId = response.json().await?;
        Ok(raw.id)
    }
}

fn upload_base(base: &str) -> String {
    base.strip_suffix("/gmail/v1").map_or_else(
        || format!("{base}/upload/gmail/v1"),
        |prefix| format!("{prefix}/upload/gmail/v1"),
    )
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
    text_color: Option<String>,
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
    #[serde(rename = "attachmentId")]
    attachment_id: Option<String>,
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
struct RawDraftList {
    drafts: Option<Vec<RawDraftRef>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}
#[derive(Deserialize)]
struct RawDraftRef {
    id: String,
    message: RawRef,
}
/// Every draft write (create/update/promote) answers with a resource whose
/// only dependable field is its id.
#[derive(Deserialize)]
struct RawId {
    id: String,
}
#[derive(Deserialize)]
struct RawDraft {
    id: String,
    message: RawDraftMessage,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDraftMessage {
    id: String,
    thread_id: String,
    history_id: String,
    label_ids: Option<Vec<String>>,
    snippet: Option<String>,
    internal_date: Option<String>,
    payload: RawPart,
}
impl RawDraftMessage {
    fn into_raw(self) -> Result<RawMessage, GmailError> {
        Ok(RawMessage {
            id: self.id,
            thread_id: self.thread_id,
            history_id: self.history_id,
            label_ids: self.label_ids,
            snippet: self.snippet,
            internal_date: self.internal_date,
            payload: self.payload,
        })
    }
}
#[derive(Deserialize)]
struct RawAttachment {
    data: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftUpload<'a> {
    message: DraftUploadMessage<'a>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftUploadMessage<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_id: Option<&'a str>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SendDraftRequest<'a> {
    id: &'a str,
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
    let raw_headers = raw.payload.headers.as_deref().unwrap_or_default();
    let headers = headers(raw_headers);
    let mut content = Content::default();
    collect_part(&raw.payload, &mut content);
    GmailMessage {
        id: raw.id,
        thread_id: raw.thread_id,
        history_id: number(&raw.history_id),
        label_ids: raw.label_ids.unwrap_or_default(),
        snippet: raw.snippet.unwrap_or_default(),
        sent_at: received_at(raw_headers)
            .or_else(|| {
                raw.internal_date
                    .as_deref()
                    .and_then(|value| value.parse::<i64>().ok())
                    // `internalDate` is epoch milliseconds; storage keeps seconds.
                    .and_then(DateTime::from_timestamp_millis)
                    .map(|value| value.timestamp())
            })
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
        to_recipients: headers.get("to").cloned().unwrap_or_default(),
        cc_recipients: headers.get("cc").cloned().unwrap_or_default(),
        bcc_recipients: headers.get("bcc").cloned().unwrap_or_default(),
        rfc_references: headers.get("references").cloned(),
        subject: headers.get("subject").cloned().unwrap_or_default(),
        html_body: content.html,
        plain_body: content.plain,
        has_attachments: content.attachments,
        inline_parts: content.inline,
        attachment_parts: content.attachment_parts,
    }
}
#[derive(Default)]
struct Content {
    html: Option<String>,
    plain: Option<String>,
    attachments: bool,
    attachment_parts: Vec<AttachmentPart>,
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
        if let Some(attachment_id) = part
            .body
            .as_ref()
            .and_then(|body| body.attachment_id.as_deref())
        {
            content.attachment_parts.push(AttachmentPart {
                attachment_id: attachment_id.to_owned(),
                filename: part.filename.clone().unwrap_or_default(),
                mime_type: mime.clone(),
            });
        }
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
/// When Gmail's own MX accepted the message — the timestamp after the final
/// `;` of the *topmost* `Received:` hop. This is what Gmail's list shows, and
/// it is the only field that stays right for delayed mail: `internalDate` can
/// carry the sender's `Date:` instead, which a queued or clock-skewed sender
/// puts hours out (a bounce queued overnight showed as the previous evening).
fn received_at(values: &[RawHeader]) -> Option<i64> {
    let hop = values
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case("received"))?;
    let (_, stamp) = hop.value.rsplit_once(';')?;
    DateTime::parse_from_rfc2822(stamp.trim())
        .ok()
        .map(|value| value.timestamp())
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
