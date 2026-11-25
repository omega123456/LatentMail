use crate::{
    gmail::GmailMessage,
    storage::{
        Attachment, AttachmentRepository, HtmlPresence, InlinePart, LabelRepository, Message,
        MessageKey, MessageRepository, RecipientRolesUpdate, ThreadRepository,
    },
};
use rusqlite::Connection;

pub struct DraftReplacement<'a> {
    pub account_id: &'a str,
    pub draft_id: &'a str,
    pub replacement: &'a GmailMessage,
    pub consumed: bool,
}

pub fn attachment_records(value: &GmailMessage) -> Vec<Attachment> {
    attachment_records_from_parts(&value.attachment_parts)
}

pub fn attachment_records_from_parts(parts: &[crate::gmail::AttachmentPart]) -> Vec<Attachment> {
    parts
        .iter()
        .enumerate()
        .map(|(position, part)| Attachment {
            attachment_id: part.attachment_id.clone(),
            filename: part.filename.clone(),
            mime_type: part.mime_type.clone(),
            size: part.size as i64,
            position: position as i64,
        })
        .collect()
}

pub fn message(account_id: &str, value: &GmailMessage) -> Message {
    Message {
        account_id: account_id.to_owned(),
        id: value.id.clone(),
        thread_id: value.thread_id.clone(),
        rfc_message_id: value.rfc_message_id.clone(),
        sender: value.sender.clone(),
        recipients: value.recipients.clone(),
        subject: value.subject.clone(),
        sent_at: value.sent_at,
        snippet: value.snippet.clone(),
        html_body: value.html_body.clone(),
        plain_body: value.plain_body.clone(),
        has_attachments: value.has_attachments,
        is_unread: value.label_ids.iter().any(|id| id == "UNREAD"),
        is_starred: value.label_ids.iter().any(|id| id == "STARRED"),
        history_id: value.history_id,
        truncated_body: None,
        html_presence: HtmlPresence::from_fetched_body(value.html_body.as_deref()),
    }
}
pub fn persist(
    connection: &Connection,
    account_id: &str,
    value: &GmailMessage,
) -> rusqlite::Result<()> {
    let key = MessageKey {
        account_id: account_id,
        message_id: &value.id,
    };
    if MessageRepository::write_full_state(connection, &message(account_id, value))? {
        MessageRepository::set_recipient_roles(
            connection,
            key,
            RecipientRolesUpdate {
                to: &value.to_recipients,
                cc: &value.cc_recipients,
                bcc: &value.bcc_recipients,
                references: value.rfc_references.as_deref(),
            },
        )?;
        write_label_membership(connection, key, &value.label_ids)?;
        let parts = value
            .inline_parts
            .iter()
            .map(|part| InlinePart {
                content_id: part.content_id.clone(),
                mime_type: part.mime_type.clone(),
                bytes: part.bytes.clone(),
            })
            .collect::<Vec<_>>();
        MessageRepository::replace_inline_parts(connection, key, &parts)?;
    }

    AttachmentRepository::replace_for_message(connection, key, &attachment_records(value))?;
    Ok(())
}

pub(crate) fn write_label_membership(
    connection: &Connection,
    message: MessageKey<'_>,
    label_ids: &[String],
) -> rusqlite::Result<()> {
    for label_id in label_ids {
        LabelRepository::ensure_placeholder(connection, message.account_id, label_id)?;
    }
    MessageRepository::replace_label_rows(connection, message, label_ids)
}

pub fn replace_draft(
    connection: &Connection,
    update: DraftReplacement<'_>,
) -> rusqlite::Result<()> {
    let transaction = connection.unchecked_transaction()?;
    replace_draft_rows(&transaction, update)?;
    transaction.commit()
}

pub(crate) fn replace_draft_rows(
    connection: &Connection,
    update: DraftReplacement<'_>,
) -> rusqlite::Result<()> {
    let old_thread =
        MessageRepository::delete_by_draft_id(connection, update.account_id, update.draft_id)?;
    persist(connection, update.account_id, update.replacement)?;
    if !update.consumed {
        MessageRepository::set_draft_id(
            connection,
            MessageKey {
                account_id: update.account_id,
                message_id: &update.replacement.id,
            },
            update.draft_id,
        )?;
    }
    if update.consumed {
        crate::storage::ComposeDraftMetadataRepository::remove(
            connection,
            update.account_id,
            update.draft_id,
        )?;
    }
    ThreadRepository::recompute(connection, update.account_id, &update.replacement.thread_id)?;
    if let Some(thread) = old_thread.filter(|thread| thread != &update.replacement.thread_id) {
        ThreadRepository::recompute(connection, update.account_id, &thread)?;
    }
    Ok(())
}
