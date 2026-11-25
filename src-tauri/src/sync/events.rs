use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use crate::sync::SyncState;

pub type EventSink = Arc<dyn Fn(&'static str, serde_json::Value) + Send + Sync>;

pub fn noop_event_sink() -> EventSink {
    Arc::new(|_, _| {})
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgressEvent {
    pub account_id: String,
    pub state: SyncState,
}

pub fn emit_progress(sink: &EventSink, event: SyncProgressEvent) {
    sink(
        crate::events::SYNC_PROGRESS,
        serde_json::to_value(event).expect("SyncProgressEvent always serializes"),
    );
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCompleteEvent {
    pub account_id: String,
    pub history_id: i64,
    pub added_count: u32,
    pub changed: bool,
    pub completed_at: i64,
}

pub fn emit_complete(sink: &EventSink, event: SyncCompleteEvent) {
    sink(
        crate::events::SYNC_COMPLETE,
        serde_json::to_value(event).expect("SyncCompleteEvent always serializes"),
    );
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailArrival {
    pub thread_id: String,
    pub sender: String,
    pub subject: String,
    pub snippet: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMailEvent {
    pub account_id: String,
    pub thread_ids: Vec<String>,
    pub arrivals: Vec<MailArrival>,
}

pub fn emit_new_mail(sink: &EventSink, event: NewMailEvent) {
    sink(
        crate::events::MAIL_NEW,
        serde_json::to_value(event).expect("NewMailEvent always serializes"),
    );
}

pub fn emitting_event_sink<R: Runtime>(handle: AppHandle<R>) -> EventSink {
    Arc::new(move |event, payload| {
        if event != crate::events::QUEUE_SUMMARY {
            tracing::info!(target: "events", "emit {event}");
        }
        if let Err(error) = handle.emit(event, payload) {
            tracing::error!(target: "events", "emit {event} failed: {error}");
        }
    })
}
