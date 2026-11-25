use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Result};

use super::super::message::message;
use super::super::shared::string_pair_row;
use super::MessageRepository;
use crate::storage::{
    Attachment, ConversationBody, ConversationEntryScope, ConversationMessage, MessageKey,
    RecipientRoles, ThreadKey,
};

fn conversation_metadata_sql(include_trashed_and_spammed: bool) -> &'static str {
    if include_trashed_and_spammed {
        return "SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,NULL,NULL,has_attachments,is_unread,is_starred,history_id,NULL,html_presence,to_recipients,cc_recipients,bcc_recipients,draft_id
             FROM messages WHERE account_id=?1 AND thread_id=?2 ORDER BY sent_at,id";
    }
    "SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,NULL,NULL,has_attachments,is_unread,is_starred,history_id,NULL,html_presence,to_recipients,cc_recipients,bcc_recipients,draft_id
             FROM messages m WHERE account_id=?1 AND thread_id=?2
               AND NOT EXISTS (
                 SELECT 1 FROM message_labels ml
                 WHERE ml.account_id=m.account_id AND ml.message_id=m.id
                   AND ml.label_id IN ('TRASH','SPAM')
               )
             ORDER BY sent_at,id"
}

fn conversation_body_sql(include_trashed_and_spammed: bool) -> &'static str {
    if include_trashed_and_spammed {
        return "SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence FROM messages WHERE account_id=?1 AND id=?2";
    }
    "SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence FROM messages m WHERE account_id=?1 AND id=?2 AND NOT EXISTS (SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id IN ('TRASH','SPAM'))"
}

struct IndexedConversationMessages<'a> {
    messages: &'a mut [ConversationMessage],
    positions: &'a HashMap<String, usize>,
}

impl IndexedConversationMessages<'_> {
    fn push_label(&mut self, message_id: &str, label_id: String) {
        if let Some(&index) = self.positions.get(message_id) {
            self.messages[index].label_ids.push(label_id);
        }
    }

    fn push_attachment(&mut self, message_id: &str, attachment: Attachment) {
        if let Some(&index) = self.positions.get(message_id) {
            self.messages[index].attachments.push(attachment);
        }
    }
}

fn map_conversation_message(row: &rusqlite::Row<'_>) -> Result<ConversationMessage> {
    Ok(ConversationMessage {
        message: message(row)?,
        recipient_roles: RecipientRoles {
            to: row.get(17)?,
            cc: row.get(18)?,
            bcc: row.get(19)?,
        },
        label_ids: Vec::new(),
        inline_content_ids: Vec::new(),
        draft_id: row.get(20)?,
        attachments: Vec::new(),
    })
}

fn attach_conversation_labels(
    connection: &Connection,
    thread: ThreadKey<'_>,
    indexed: &mut IndexedConversationMessages<'_>,
) -> Result<()> {
    let mut statement = connection.prepare(
        "SELECT ml.message_id,ml.label_id
         FROM messages m CROSS JOIN message_labels ml
         WHERE m.account_id=?1 AND m.thread_id=?2
           AND ml.account_id=m.account_id AND ml.message_id=m.id",
    )?;
    let labels = statement
        .query_map(
            params![thread.account_id, thread.thread_id],
            string_pair_row,
        )?
        .collect::<Result<Vec<_>>>()?;
    for pair in labels {
        indexed.push_label(&pair.first, pair.second);
    }
    for message in indexed.messages.iter_mut() {
        message.label_ids.sort();
    }
    Ok(())
}

fn attach_conversation_attachments(
    connection: &Connection,
    thread: ThreadKey<'_>,
    indexed: &mut IndexedConversationMessages<'_>,
) -> Result<()> {
    let mut statement = connection.prepare(
        "SELECT a.message_id,a.attachment_id,a.filename,a.mime_type,a.size,a.position
         FROM messages m CROSS JOIN message_attachments a
         WHERE m.account_id=?1 AND m.thread_id=?2
           AND a.account_id=m.account_id AND a.message_id=m.id",
    )?;
    let attachment_rows = statement
        .query_map(params![thread.account_id, thread.thread_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Attachment {
                    attachment_id: row.get(1)?,
                    filename: row.get(2)?,
                    mime_type: row.get(3)?,
                    size: row.get(4)?,
                    position: row.get(5)?,
                },
            ))
        })?
        .collect::<Result<Vec<_>>>()?;
    for (message_id, attachment) in attachment_rows {
        indexed.push_attachment(&message_id, attachment);
    }
    for message in indexed.messages.iter_mut() {
        message.attachments.sort_by_key(|value| value.position);
    }
    Ok(())
}

impl MessageRepository {
    pub fn list_conversation_metadata(
        connection: &Connection,
        thread: ThreadKey<'_>,
        entry_scope: Option<&ConversationEntryScope>,
    ) -> Result<Vec<ConversationMessage>> {
        let include_trashed_and_spammed =
            entry_scope.is_some_and(ConversationEntryScope::includes_trashed_and_spammed);
        let sql = conversation_metadata_sql(include_trashed_and_spammed);
        let mut statement = connection.prepare_cached(sql)?;
        let mut messages = statement
            .query_map(
                params![thread.account_id, thread.thread_id],
                map_conversation_message,
            )?
            .collect::<Result<Vec<_>>>()?;
        let positions: HashMap<String, usize> = messages
            .iter()
            .enumerate()
            .map(|(index, value)| (value.message.id.clone(), index))
            .collect();
        let mut indexed = IndexedConversationMessages {
            messages: &mut messages,
            positions: &positions,
        };
        attach_conversation_labels(connection, thread, &mut indexed)?;
        attach_conversation_attachments(connection, thread, &mut indexed)?;
        Ok(messages)
    }

    pub fn conversation_body(
        connection: &Connection,
        target: MessageKey<'_>,
        entry_scope: Option<&ConversationEntryScope>,
    ) -> Result<Option<ConversationBody>> {
        let include_trashed_and_spammed =
            entry_scope.is_some_and(ConversationEntryScope::includes_trashed_and_spammed);
        let sql = conversation_body_sql(include_trashed_and_spammed);
        let message = connection
            .prepare_cached(sql)?
            .query_row(params![target.account_id, target.message_id], message)
            .optional()?;
        let Some(message) = message else {
            return Ok(None);
        };
        let content_ids =
            Self::inline_content_ids(connection, target.account_id, target.message_id)?;
        Ok(Some(ConversationBody {
            message: message,
            inline_content_ids: content_ids,
        }))
    }
}
