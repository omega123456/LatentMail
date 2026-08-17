use crate::{
    gmail::GmailMessage,
    storage::{
        HtmlPresence, InlinePart, LabelRepository, Message, MessageRepository, ThreadRepository,
    },
};
use rusqlite::Connection;

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
    if MessageRepository::write_full_state(connection, &message(account_id, value))? {
        MessageRepository::set_recipient_roles(
            connection,
            account_id,
            &value.id,
            &value.to_recipients,
            &value.cc_recipients,
            &value.bcc_recipients,
            value.rfc_references.as_deref(),
        )?;
        for label in &value.label_ids {
            LabelRepository::ensure_placeholder(connection, account_id, label)?;
            MessageRepository::set_label_membership(
                connection, account_id, &value.id, label, true,
            )?;
        }
        let parts = value
            .inline_parts
            .iter()
            .map(|part| InlinePart {
                content_id: part.content_id.clone(),
                mime_type: part.mime_type.clone(),
                bytes: part.bytes.clone(),
            })
            .collect::<Vec<_>>();
        MessageRepository::replace_inline_parts(connection, account_id, &value.id, &parts)?;
    }
    Ok(())
}

pub fn replace_draft(
    connection: &Connection,
    account_id: &str,
    draft_id: &str,
    replacement: &GmailMessage,
    consumed: bool,
) -> rusqlite::Result<()> {
    let transaction = connection.unchecked_transaction()?;
    replace_draft_rows(&transaction, account_id, draft_id, replacement, consumed)?;
    transaction.commit()
}

pub(crate) fn replace_draft_rows(
    connection: &Connection,
    account_id: &str,
    draft_id: &str,
    replacement: &GmailMessage,
    consumed: bool,
) -> rusqlite::Result<()> {
    let old_thread = MessageRepository::delete_by_draft_id(connection, account_id, draft_id)?;
    persist(connection, account_id, replacement)?;
    if !consumed {
        MessageRepository::set_draft_id(connection, account_id, &replacement.id, draft_id)?;
    }
    if consumed {
        crate::storage::ComposeDraftMetadataRepository::remove(connection, account_id, draft_id)?;
    }
    ThreadRepository::recompute(connection, account_id, &replacement.thread_id)?;
    if let Some(thread) = old_thread.filter(|thread| thread != &replacement.thread_id) {
        ThreadRepository::recompute(connection, account_id, &thread)?;
    }
    Ok(())
}
