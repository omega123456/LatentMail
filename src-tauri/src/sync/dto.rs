//! IPC-facing shapes for the Mail read commands and sync status, kept
//! separate from the storage/gmail domain types they're built from.

use serde::{Deserialize, Serialize};

use crate::storage::{
    HtmlPresence, Label, Message, Thread, TraversalCursor, TraversalKind as StorageTraversalKind,
};

use super::SyncState;

/// The IPC-facing shape of a label's Gmail colour pair (D10), replacing the
/// fabricated 3-colour cycle `mappers.ts` used to apply client-side.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LabelColorDto {
    pub text: String,
    pub background: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LabelDto {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub color: Option<LabelColorDto>,
    pub message_count: i64,
    pub unread_count: i64,
}

impl From<Label> for LabelDto {
    fn from(label: Label) -> Self {
        Self {
            id: label.id,
            name: label.name,
            kind: label.kind,
            color: label.color.map(|color| LabelColorDto {
                text: color.text,
                background: color.background,
            }),
            message_count: label.message_count,
            unread_count: label.unread_count,
        }
    }
}

/// Which whole-mailbox traversal is running — mirrors
/// [`crate::storage::TraversalKind`], fully defined (including the
/// reconciliation variant) even though reconciliation itself is Phase 5,
/// so Phase 6 can render reconciliation wording without depending on it.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TraversalKind {
    Backfill,
    Reconciliation,
}
impl From<StorageTraversalKind> for TraversalKind {
    fn from(kind: StorageTraversalKind) -> Self {
        match kind {
            StorageTraversalKind::Backfill => Self::Backfill,
            StorageTraversalKind::Reconciliation => Self::Reconciliation,
        }
    }
}

/// Traversal progress is always a count, never a percentage or estimate
/// (D11).
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TraversalState {
    NotStarted,
    Backfilling,
    Reconciling,
    Complete,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TraversalStatusDto {
    pub account_id: String,
    pub state: TraversalState,
    pub kind: Option<TraversalKind>,
    pub discovered_count: i64,
    pub persisted_count: i64,
    pub last_advanced_at: Option<i64>,
    /// True when the *current run* started from an already-saved checkpoint
    /// position — i.e. this traversal is picking back up after a previous
    /// process/run was interrupted, not starting fresh from page one.
    ///
    /// Sourced from [`TraversalCursor::resumed`], a flag snapshotted once
    /// when a run begins (see `sync::traversal::run_backfill_step`) —
    /// deliberately *not* re-derived from `position.is_some()` on every
    /// read, because backfill writes a non-null `position` on every
    /// committed page. Deriving this live would make an uninterrupted run's
    /// status flip to "resumed" from page 2 onward, even though nothing was
    /// ever interrupted.
    pub is_resumed: bool,
}

impl TraversalStatusDto {
    /// No cursor row exists yet — a mailbox that has never started a
    /// backfill or reconciliation pass.
    pub fn not_started(account_id: String) -> Self {
        Self {
            account_id,
            state: TraversalState::NotStarted,
            kind: None,
            discovered_count: 0,
            persisted_count: 0,
            last_advanced_at: None,
            is_resumed: false,
        }
    }
}

impl TraversalStatusDto {
    /// Backfill and reconciliation now keep independent cursor rows
    /// (`(account_id, kind)`, migration `V4__traversal_cursor_composite_key`),
    /// so `read_traversal_status` has two rows to reconcile into one status
    /// rather than one. The queue's per-account entity lock (D3) means at
    /// most one of the two traversals is ever actually running at a time,
    /// so whichever cursor advanced most recently is the current/last
    /// activity worth surfacing to the UI.
    pub fn most_recent(
        account_id: String,
        backfill: Option<TraversalCursor>,
        reconciliation: Option<TraversalCursor>,
    ) -> Self {
        match (backfill, reconciliation) {
            (None, None) => Self::not_started(account_id),
            (Some(cursor), None) | (None, Some(cursor)) => Self::from(cursor),
            (Some(backfill), Some(reconciliation)) => {
                if reconciliation.last_advanced_at >= backfill.last_advanced_at {
                    Self::from(reconciliation)
                } else {
                    Self::from(backfill)
                }
            }
        }
    }
}

impl From<TraversalCursor> for TraversalStatusDto {
    fn from(cursor: TraversalCursor) -> Self {
        let kind: TraversalKind = cursor.kind.into();
        let state = if cursor.completed {
            TraversalState::Complete
        } else {
            match kind {
                TraversalKind::Backfill => TraversalState::Backfilling,
                TraversalKind::Reconciliation => TraversalState::Reconciling,
            }
        };
        Self {
            account_id: cursor.account_id,
            state,
            kind: Some(kind),
            discovered_count: cursor.discovered_count,
            persisted_count: cursor.persisted_count,
            last_advanced_at: Some(to_millis(cursor.last_advanced_at)),
            is_resumed: cursor.resumed,
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
    pub to_recipients: Vec<String>,
    pub cc_recipients: Vec<String>,
    pub bcc_recipients: Vec<String>,
    pub subject: String,
    pub sent_at: i64,
    pub snippet: String,
    pub html_body: Option<String>,
    pub html_presence: HtmlPresenceDto,
    pub plain_body: Option<String>,
    pub has_attachments: bool,
    pub is_unread: bool,
    pub is_starred: bool,
    pub label_ids: Vec<String>,
    pub remote_images_blocked: bool,
    pub draft_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HtmlPresenceDto {
    NeverFetched,
    Present,
    Absent,
}

impl From<HtmlPresence> for HtmlPresenceDto {
    fn from(value: HtmlPresence) -> Self {
        match value {
            HtmlPresence::NeverFetched => Self::NeverFetched,
            HtmlPresence::Present => Self::Present,
            HtmlPresence::Absent => Self::Absent,
        }
    }
}

pub fn message_dto(
    message: Message,
    recipient_roles: (String, String, String),
    label_ids: Vec<String>,
    html_body: Option<String>,
    remote_images_blocked: bool,
    draft_id: Option<String>,
) -> MessageDto {
    MessageDto {
        id: message.id,
        sender: message.sender,
        recipients: split_list(&message.recipients),
        to_recipients: split_list(&recipient_roles.0),
        cc_recipients: split_list(&recipient_roles.1),
        bcc_recipients: split_list(&recipient_roles.2),
        subject: message.subject,
        sent_at: to_millis(message.sent_at),
        snippet: message.snippet,
        html_body,
        html_presence: message.html_presence.into(),
        plain_body: message.plain_body,
        has_attachments: message.has_attachments,
        is_unread: message.is_unread,
        is_starred: message.is_starred,
        label_ids,
        remote_images_blocked,
        draft_id,
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDto {
    pub thread_id: String,
    pub subject: String,
    pub messages: Vec<MessageDto>,
}

/// The per-thread outcome of a `mutate_threads` request — mirrors
/// [`super::MutationOutcome`], serialized for IPC.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MutationResultDto {
    pub thread_id: String,
    pub outcome: MutationOutcomeDto,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MutationOutcomeDto {
    Applied,
    Superseded,
}
impl From<super::MutationOutcome> for MutationOutcomeDto {
    fn from(outcome: super::MutationOutcome) -> Self {
        match outcome {
            super::MutationOutcome::Applied => Self::Applied,
            super::MutationOutcome::Superseded => Self::Superseded,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusDto {
    pub account_id: String,
    pub state: SyncState,
    pub last_synced_at: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContactSuggestionDto {
    pub address: String,
    pub display_name: Option<String>,
}

/// The staged-attachment payload crossing IPC once a path/bytes source has
/// been read into Rust-owned canonical staging. Never carries bytes (D3) —
/// `path` is an app-private, staging-scoped absolute path the frontend uses
/// only as an opaque handle plus (once Phase 4 wires the asset scope) an
/// inline-image preview source.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StagedAttachmentDto {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub path: String,
    pub content_id: Option<String>,
    pub size: u64,
}

impl From<crate::compose::staging::StagedPart> for StagedAttachmentDto {
    fn from(value: crate::compose::staging::StagedPart) -> Self {
        Self {
            id: value.id,
            filename: value.filename,
            mime_type: value.mime_type,
            path: value.path.to_string_lossy().into_owned(),
            content_id: value.content_id,
            size: value.size,
        }
    }
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
