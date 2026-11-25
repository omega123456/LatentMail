use rusqlite::Result;
use serde::Deserialize;

use crate::storage::Attachment;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HtmlPresence {
    NeverFetched,
    Present,
    Absent,
    TooLarge,
}

impl HtmlPresence {
    pub(super) fn as_db_str(self) -> &'static str {
        match self {
            Self::NeverFetched => "never_fetched",
            Self::Present => "present",
            Self::Absent => "absent",
            Self::TooLarge => "too_large",
        }
    }
    fn from_db_str(value: &str) -> Self {
        match value {
            "present" => Self::Present,
            "absent" => Self::Absent,
            "too_large" => Self::TooLarge,
            _ => Self::NeverFetched,
        }
    }

    pub fn from_fetched_body(html_body: Option<&str>) -> Self {
        if html_body.is_some() {
            return Self::Present;
        }
        Self::Absent
    }
}

pub fn truncate_body(plain: Option<&str>, html: Option<&str>) -> Option<String> {
    const MAX_CHARS: usize = 10_000;
    let source = plain.map(str::to_owned).or_else(|| html.map(strip_tags))?;
    Some(source.chars().take(MAX_CHARS).collect())
}

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub account_id: String,
    pub id: String,
    pub thread_id: String,
    pub rfc_message_id: Option<String>,
    pub sender: String,
    pub recipients: String,
    pub subject: String,
    pub sent_at: i64,
    pub snippet: String,
    pub html_body: Option<String>,
    pub plain_body: Option<String>,
    pub has_attachments: bool,
    pub is_unread: bool,
    pub is_starred: bool,
    pub history_id: i64,
    pub truncated_body: Option<String>,
    pub html_presence: HtmlPresence,
}

impl Message {
    pub fn body_is_empty(&self) -> bool {
        self.html_body.is_none() && self.plain_body.is_none()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecipientRoles {
    pub to: String,
    pub cc: String,
    pub bcc: String,
}

#[derive(Debug, Clone, Copy)]
pub struct MessageKey<'a> {
    pub account_id: &'a str,
    pub message_id: &'a str,
}

#[derive(Debug, Clone, Copy)]
pub struct ThreadKey<'a> {
    pub account_id: &'a str,
    pub thread_id: &'a str,
}

pub struct RecipientRolesUpdate<'a> {
    pub to: &'a str,
    pub cc: &'a str,
    pub bcc: &'a str,
    pub references: Option<&'a str>,
}

pub struct MessageBodyUpdate<'a> {
    pub html_body: Option<&'a str>,
    pub plain_body: Option<&'a str>,
    pub presence: HtmlPresence,
}

pub struct MutationHistoryUpdate<'a> {
    pub ids: &'a [String],
    pub history_id: i64,
}

pub struct LabelMembershipChange<'a> {
    pub label_id: &'a str,
    pub present: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationBody {
    pub message: Message,
    pub inline_content_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlinePartData {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposeMessageContext {
    pub message: Message,
    pub recipient_roles: RecipientRoles,
    pub references: Option<String>,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationMessage {
    pub message: Message,
    pub recipient_roles: RecipientRoles,
    pub label_ids: Vec<String>,
    pub inline_content_ids: Vec<String>,
    pub draft_id: Option<String>,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConversationEntryScope {
    Mailbox {
        mailbox_id: String,
    },
    Search {
        scope: crate::search::scope::SearchScope,
    },
}

impl ConversationEntryScope {
    pub(super) fn includes_trashed_and_spammed(&self) -> bool {
        match self {
            Self::Mailbox { mailbox_id } => {
                crate::gmail::system_labels::is_trash_or_spam(mailbox_id)
            }
            Self::Search { scope } => {
                crate::search::scope::resolve(scope).includes_trashed_and_spammed()
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciliationMessage {
    pub thread_id: String,
    pub sender: String,
    pub sent_at: i64,
    pub to_recipients: String,
    pub cc_recipients: String,
    pub label_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlinePart {
    pub content_id: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

pub(super) fn message(row: &rusqlite::Row<'_>) -> Result<Message> {
    let html_presence: String = row.get(16)?;
    Ok(Message {
        account_id: row.get(0)?,
        id: row.get(1)?,
        thread_id: row.get(2)?,
        rfc_message_id: row.get(3)?,
        sender: row.get(4)?,
        recipients: row.get(5)?,
        subject: row.get(6)?,
        sent_at: row.get(7)?,
        snippet: row.get(8)?,
        html_body: row.get(9)?,
        plain_body: row.get(10)?,
        has_attachments: row.get(11)?,
        is_unread: row.get(12)?,
        is_starred: row.get(13)?,
        history_id: row.get(14)?,
        truncated_body: row.get(15)?,
        html_presence: HtmlPresence::from_db_str(&html_presence),
    })
}
