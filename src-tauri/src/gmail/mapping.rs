use std::collections::HashMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::DateTime;

use super::mime_parts::{classify_attachments, collect_part, Content};
use super::wire::{RawHeader, RawHistoryMessage, RawHistoryRecord, RawLabelChange, RawMessage};
use super::{GmailMessage, HistoryRecord, LabelChange, MessageRef};

fn decode_snippet_entities(text: &str) -> String {
    html2text::from_read(text.as_bytes(), text.len() + 1)
        .unwrap_or_else(|_| text.to_owned())
        .trim_end()
        .to_owned()
}

pub(super) fn map_message(raw: RawMessage) -> GmailMessage {
    let raw_headers = raw.payload.headers.as_deref().unwrap_or_default();
    let headers = headers(raw_headers);
    let mut content = Content::default();
    collect_part(&raw.payload, &mut content);
    let attachment_parts = classify_attachments(content.candidates, content.html.as_deref());
    let has_attachments = !attachment_parts.is_empty();
    GmailMessage {
        id: raw.id,
        thread_id: raw.thread_id,
        history_id: number(&raw.history_id),
        label_ids: raw.label_ids.unwrap_or_default(),
        snippet: decode_snippet_entities(&raw.snippet.unwrap_or_default()),
        sent_at: received_at(raw_headers)
            .or_else(|| {
                raw.internal_date
                    .as_deref()
                    .and_then(|value| value.parse::<i64>().ok())
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
        has_attachments: has_attachments,
        inline_parts: content.inline,
        attachment_parts: attachment_parts,
        oversize: false,
    }
}

pub(super) fn decode(value: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value.trim_end_matches('=').as_bytes())
        .ok()
}

pub(super) fn bytes_to_text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}

fn received_at(values: &[RawHeader]) -> Option<i64> {
    let hop = values
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case("received"))?;
    let (_, stamp) = hop.value.rsplit_once(';')?;
    DateTime::parse_from_rfc2822(stamp.trim())
        .ok()
        .map(|value| value.timestamp())
}

pub(super) fn headers(values: &[RawHeader]) -> HashMap<String, String> {
    values
        .iter()
        .map(|header| (header.name.to_ascii_lowercase(), header.value.clone()))
        .collect()
}

pub(super) fn number(value: &str) -> i64 {
    value.parse().unwrap_or_default()
}

pub(super) fn map_history(value: RawHistoryRecord) -> HistoryRecord {
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
        messages: value
            .messages
            .unwrap_or_default()
            .into_iter()
            .map(|item| MessageRef {
                id: item.id,
                thread_id: item.thread_id.unwrap_or_default(),
            })
            .collect(),
        messages_added: refs(value.messages_added),
        messages_deleted: refs(value.messages_deleted),
        labels_added: changes(value.labels_added),
        labels_removed: changes(value.labels_removed),
    }
}
