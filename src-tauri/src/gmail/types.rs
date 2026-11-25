use thiserror::Error;

use super::{DEFAULT_PAGE_SIZE, MAX_GMAIL_RESPONSE_BYTES};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Profile {
    pub email_address: String,
    pub messages_total: i64,
    pub threads_total: i64,
    pub history_id: i64,
}

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
    pub content_id: Option<String>,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    pub inline_bytes: Option<Vec<u8>>,
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
    pub oversize: bool,
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

    pub messages: Vec<MessageRef>,
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
    #[error("invalid Gmail raw message payload")]
    RawMessageData,
    #[error("Gmail response exceeded the {MAX_GMAIL_RESPONSE_BYTES}-byte cap")]
    ResponseTooLarge,
}

pub struct AccountClientConfig<'a> {
    pub account_id: &'a str,
    pub access_token: String,
    pub base_url: String,
}

pub struct MessageListQuery<'a> {
    pub label_ids: &'a [String],
    pub query_filter: Option<&'a str>,
    pub page_token: Option<&'a str>,
    pub options: ListOptions,
}

pub struct DraftContent<'a> {
    pub raw: &'a [u8],
    pub thread_id: Option<&'a str>,
}

pub struct LabelModification<'a> {
    pub add_label_ids: &'a [String],
    pub remove_label_ids: &'a [String],
}
