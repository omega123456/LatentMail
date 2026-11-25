use serde::{Deserialize, Serialize};

use super::{labels, GmailError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawProfile {
    pub(super) email_address: String,
    pub(super) messages_total: i64,
    pub(super) threads_total: i64,
    pub(super) history_id: String,
}

#[derive(Deserialize)]
pub(super) struct RawLabels {
    pub(super) labels: Vec<labels::RawLabel>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawMessageList {
    pub(super) messages: Option<Vec<RawRef>>,
    pub(super) next_page_token: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawRef {
    pub(super) id: String,
    pub(super) thread_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawMessage {
    pub(super) id: String,
    pub(super) thread_id: String,
    pub(super) history_id: String,
    pub(super) label_ids: Option<Vec<String>>,
    pub(super) snippet: Option<String>,
    pub(super) internal_date: Option<String>,
    pub(super) payload: RawPart,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawPart {
    pub(super) mime_type: Option<String>,
    pub(super) filename: Option<String>,
    pub(super) headers: Option<Vec<RawHeader>>,
    pub(super) body: Option<RawBody>,
    pub(super) parts: Option<Vec<RawPart>>,
}

#[derive(Deserialize)]
pub(super) struct RawHeader {
    pub(super) name: String,
    pub(super) value: String,
}

#[derive(Deserialize)]
pub(super) struct RawBody {
    pub(super) data: Option<String>,
    #[serde(rename = "attachmentId")]
    pub(super) attachment_id: Option<String>,
    pub(super) size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModifyRequest<'a> {
    pub(super) add_label_ids: &'a [String],
    pub(super) remove_label_ids: &'a [String],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BatchModifyRequest<'a> {
    pub(super) ids: &'a [String],
    pub(super) add_label_ids: &'a [String],
    pub(super) remove_label_ids: &'a [String],
}

#[derive(Deserialize)]
pub(super) struct RawDraftList {
    pub(super) drafts: Option<Vec<RawDraftRef>>,
    #[serde(rename = "nextPageToken")]
    pub(super) next_page_token: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct RawDraftRef {
    pub(super) id: String,
    pub(super) message: RawRef,
}

#[derive(Deserialize)]
pub(super) struct RawId {
    pub(super) id: String,
}

#[derive(Deserialize)]
pub(super) struct RawDraft {
    pub(super) id: String,
    pub(super) message: RawDraftMessage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawDraftMessage {
    pub(super) id: String,
    pub(super) thread_id: String,
    pub(super) history_id: String,
    pub(super) label_ids: Option<Vec<String>>,
    pub(super) snippet: Option<String>,
    pub(super) internal_date: Option<String>,
    pub(super) payload: RawPart,
}

impl RawDraftMessage {
    pub(super) fn into_raw(self) -> Result<RawMessage, GmailError> {
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
pub(super) struct RawAttachment {
    pub(super) data: String,
}

#[derive(Deserialize)]
pub(super) struct RawSource {
    pub(super) raw: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DraftUpload<'a> {
    pub(super) message: DraftUploadMessage<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DraftUploadMessage<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) thread_id: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SendDraftRequest<'a> {
    pub(super) id: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawHistory {
    pub(super) history_id: String,
    pub(super) history: Option<Vec<RawHistoryRecord>>,
    pub(super) next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawHistoryRecord {
    pub(super) id: String,
    pub(super) messages: Option<Vec<RawRef>>,
    pub(super) messages_added: Option<Vec<RawHistoryMessage>>,
    pub(super) messages_deleted: Option<Vec<RawHistoryMessage>>,
    pub(super) labels_added: Option<Vec<RawLabelChange>>,
    pub(super) labels_removed: Option<Vec<RawLabelChange>>,
}

#[derive(Deserialize)]
pub(super) struct RawHistoryMessage {
    pub(super) message: RawRef,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawLabelChange {
    pub(super) message: RawRef,
    pub(super) label_ids: Vec<String>,
}
