use std::sync::LazyLock;

use reqwest::Client;

pub const GMAIL_API_BASE_URL: &str = "https://gmail.googleapis.com/gmail/v1";
const GMAIL_API_PATH: &str = "/gmail/v1";
const GMAIL_UPLOAD_PATH: &str = "/upload/gmail/v1";
const MAX_REQUEST_ATTEMPTS: u8 = 10;
const LAST_RETRYABLE_ATTEMPT: u8 = MAX_REQUEST_ATTEMPTS - 1;
const MAX_BACKOFF_EXPONENT: u8 = 5;
const MULTIPART_FRAMING_BYTES: usize = 256;
pub const PLAIN_TEXT_WRAP_COLUMNS: usize = 80;

pub const PROFILE_COST: u32 = 1;
pub const LABELS_LIST_COST: u32 = 1;
pub const MESSAGES_LIST_COST: u32 = 5;
pub const MESSAGES_GET_COST: u32 = 5;
pub const MESSAGES_MODIFY_COST: u32 = 5;
pub const MESSAGES_BATCH_MODIFY_COST: u32 = 50;
pub const HISTORY_LIST_COST: u32 = 2;

pub const LABELS_CREATE_COST: u32 = 5;
pub const LABELS_UPDATE_COST: u32 = 5;
pub const LABELS_DELETE_COST: u32 = 5;
pub const DRAFTS_DELETE_COST: u32 = 5;

pub const DRAFTS_LIST_COST: u32 = 5;
pub const DRAFTS_CREATE_COST: u32 = 5;
pub const DRAFTS_UPDATE_COST: u32 = 5;
pub const DRAFTS_GET_COST: u32 = 5;
pub const MESSAGES_SEND_COST: u32 = 5;
pub const ATTACHMENTS_GET_COST: u32 = 5;

pub const DEFAULT_PAGE_SIZE: u32 = 100;
pub const MAX_PAGE_SIZE: u32 = 500;

const LIST_FIELDS: &str = "messages(id,threadId),nextPageToken";
const MESSAGE_FIELDS: &str = "id,threadId,historyId,labelIds,snippet,internalDate,payload(headers,body,parts,filename,mimeType,partId)";
const MESSAGE_METADATA_FIELDS: &str =
    "id,threadId,historyId,labelIds,snippet,internalDate,payload(headers)";
const MAX_GMAIL_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const MAX_ATTACHMENT_RESPONSE_BYTES: usize = 40 * 1024 * 1024;
const MAX_RAW_MESSAGE_RESPONSE_BYTES: usize = 72 * 1024 * 1024;

pub const RESERVED_ATTACHMENT_ID_PREFIX: &str = "latentmail-inline-";

static HTTP_CLIENT: LazyLock<Client> = LazyLock::new(crate::http_client);

mod client;
pub mod labels;
mod mapping;
mod mime_parts;
mod rate_limit;
pub mod system_labels;
mod types;
mod wire;

pub use client::{backoff, GmailClient};
pub use rate_limit::{GmailRateLimiters, QuotaClass, ACCOUNT_RATE_PER_SECOND, TRAVERSAL_SHARE};
pub use types::{
    AccountClientConfig, AttachmentPart, DraftContent, GmailDraft, GmailError, GmailLabel,
    GmailMessage, HistoryPage, HistoryRecord, InlinePart, LabelChange, LabelColorPair,
    LabelModification, ListOptions, MessageListQuery, MessageRef, Page, Profile,
};
