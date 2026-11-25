use serde::Serialize;

use crate::{gmail::GmailError, storage::StorageError};

pub mod announce;
mod backfill;
mod cadence;
pub mod commands;
pub mod concurrency;
mod dto;
mod engine;
mod events;
mod full_sync;
mod incremental;
mod labels;
pub mod materialize;
mod mutations;
mod persist;
mod queue_bridge;
mod reconcile;
mod startup;
pub mod traversal;
pub mod triage;

pub use dto::{
    message_dto, thread_page_limit, to_millis, AttachmentDto, ContactSuggestionDto,
    ConversationDto, HtmlPresenceDto, ImagePolicy, ImagePolicyTarget, LabelColorDto, LabelDto,
    MessageBodyDto, MessageBodyFetchedDto, MessageBodyInput, MessageDto, MessageDtoInput,
    MutationOutcomeDto, MutationResultDto, ParsedSearchQueryDto, SearchPredicateDto,
    StagedAttachmentDto, SyncStatusDto, ThreadCursor, ThreadDto, ThreadPage, ThreadPageDirection,
    ThreadRowDetails, ThreadSearchPage, TraversalKind, TraversalState, TraversalStatusDto,
};

pub use cadence::{
    run_fast_cadence, run_periodic_cadence, SyncScheduler, SyncSchedulers, FAST_PROBE_INTERVAL_SECS,
};
pub use engine::{EmbeddingJob, SyncEngine, SyncEngineDeps};
pub use events::{
    emit_complete, emit_new_mail, emit_progress, emitting_event_sink, noop_event_sink, EventSink,
    MailArrival, NewMailEvent, SyncCompleteEvent, SyncProgressEvent,
};
pub(crate) use full_sync::FullSyncOutcome;
pub(crate) use labels::{sync_labels, to_label, LabelSyncTarget};
pub use mutations::{
    LabelDelta, MessageMutation, MutationOutcome, ThreadMutation, BATCH_MODIFY_CHUNK_SIZE,
};
pub use queue_bridge::{
    create_queue_engine, create_queue_engine_with_events, QueueRateConfig, WorkRegistry,
};
pub use startup::{initialize, SyncInitializer};

#[derive(Debug)]
pub enum SyncError {
    Gmail(GmailError),
    Storage(StorageError),
    QueueStopped,
    UnknownAccount,
    Failed(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Gmail(error) => write!(f, "Gmail request failed: {error}"),
            Self::Storage(error) => write!(f, "storage error: {error}"),
            Self::QueueStopped => write!(f, "sync queue is no longer accepting work"),
            Self::UnknownAccount => write!(f, "unknown account"),
            Self::Failed(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for SyncError {}

impl From<GmailError> for SyncError {
    fn from(error: GmailError) -> Self {
        Self::Gmail(error)
    }
}

impl From<StorageError> for SyncError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    Idle,
    Syncing,
    Error,
}

#[derive(Clone, Debug, Default)]
struct AccountStatus {
    state: Option<SyncState>,
    last_synced_at: Option<i64>,
    last_error: Option<String>,
}
