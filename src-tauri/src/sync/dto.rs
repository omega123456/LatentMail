//! IPC-facing shapes for the Mail read commands and sync status, kept
//! separate from the storage/gmail domain types they're built from.

use serde::{Deserialize, Serialize};

use crate::storage::{Label, Message, Thread};

use super::SyncState;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LabelDto {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub color: Option<String>,
    pub message_count: i64,
    pub unread_count: i64,
}

impl From<Label> for LabelDto {
    fn from(label: Label) -> Self {
        Self {
            id: label.id,
            name: label.name,
            kind: label.kind,
            color: label.color,
            message_count: label.message_count,
            unread_count: label.unread_count,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDto {
    pub id: String,
    pub subject: String,
    pub participants: Vec<String>,
    pub latest_at: i64,
    pub message_count: i64,
    pub is_unread: bool,
    pub is_starred: bool,
    pub has_attachments: bool,
    pub has_draft: bool,
    pub snippet: String,
    pub label_indicators: Vec<String>,
}

impl From<Thread> for ThreadDto {
    fn from(thread: Thread) -> Self {
        Self {
            id: thread.id,
            subject: thread.subject,
            participants: split_list(&thread.participants),
            latest_at: to_millis(thread.latest_at),
            message_count: thread.message_count,
            is_unread: thread.is_unread,
            is_starred: thread.is_starred,
            has_attachments: thread.has_attachments,
            has_draft: thread.has_draft,
            snippet: String::new(),
            label_indicators: Vec::new(),
        }
    }
}

impl ThreadDto {
    pub fn with_row_details(mut self, snippet: String, label_indicators: Vec<String>) -> Self {
        self.snippet = snippet;
        self.label_indicators = label_indicators;
        self
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCursor {
    pub latest_at: i64,
    pub id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPage {
    pub items: Vec<ThreadDto>,
    pub next_cursor: Option<ThreadCursor>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub id: String,
    pub sender: String,
    pub recipients: Vec<String>,
    pub subject: String,
    pub sent_at: i64,
    pub snippet: String,
    pub html_body: Option<String>,
    pub plain_body: Option<String>,
    pub has_attachments: bool,
    pub is_unread: bool,
    pub is_starred: bool,
    pub label_ids: Vec<String>,
    pub remote_images_blocked: bool,
}

pub fn message_dto(
    message: Message,
    label_ids: Vec<String>,
    html_body: Option<String>,
    remote_images_blocked: bool,
) -> MessageDto {
    MessageDto {
        id: message.id,
        sender: message.sender,
        recipients: split_list(&message.recipients),
        subject: message.subject,
        sent_at: to_millis(message.sent_at),
        snippet: message.snippet,
        html_body,
        plain_body: message.plain_body,
        has_attachments: message.has_attachments,
        is_unread: message.is_unread,
        is_starred: message.is_starred,
        label_ids,
        remote_images_blocked,
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDto {
    pub thread_id: String,
    pub subject: String,
    pub messages: Vec<MessageDto>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusDto {
    pub account_id: String,
    pub state: SyncState,
    pub last_synced_at: Option<i64>,
    pub last_error: Option<String>,
}

/// Storage keeps epoch **seconds** (the thread cursor compares against that
/// column), but every timestamp crossing IPC is fed straight into JavaScript's
/// `new Date(...)`, which expects **milliseconds** — without this every row
/// renders as January 1970.
pub(crate) fn to_millis(seconds: i64) -> i64 {
    chrono::DateTime::from_timestamp(seconds, 0).map_or(0, |value| value.timestamp_millis())
}

fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}
