use rusqlite::{params, Connection, OptionalExtension, Result};

use super::super::message::message;
use super::MessageRepository;
use crate::storage::{
    AttachmentRepository, ComposeMessageContext, MessageKey, RecipientRoles, RecipientRolesUpdate,
};

impl MessageRepository {
    pub fn compose_context(
        connection: &Connection,
        account_id: &str,
        id: &str,
    ) -> Result<Option<ComposeMessageContext>> {
        let context = connection
            .query_row(
                "SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence,to_recipients,cc_recipients,bcc_recipients,rfc_references
                 FROM messages WHERE account_id=?1 AND id=?2",
                params![account_id, id],
                |row| {
                    Ok(ComposeMessageContext {
                        message: message(row)?,
                        recipient_roles: RecipientRoles {
                            to: row.get(17)?,
                            cc: row.get(18)?,
                            bcc: row.get(19)?,
                        },
                        references: row.get(20)?,
                        attachments: Vec::new(),
                    })
                },
            )
            .optional()?;
        match context {
            Some(mut context) => {
                context.attachments =
                    AttachmentRepository::for_message(connection, account_id, id)?;
                Ok(Some(context))
            }
            None => Ok(None),
        }
    }

    pub fn recipient_roles(
        connection: &Connection,
        account_id: &str,
        id: &str,
    ) -> Result<RecipientRoles> {
        connection.query_row(
            "SELECT to_recipients,cc_recipients,bcc_recipients FROM messages WHERE account_id=?1 AND id=?2",
            params![account_id, id],
            |row| {
                Ok(RecipientRoles {
                    to: row.get(0)?,
                    cc: row.get(1)?,
                    bcc: row.get(2)?,
                })
            },
        )
    }

    pub fn set_recipient_roles(
        connection: &Connection,
        message: MessageKey<'_>,
        update: RecipientRolesUpdate<'_>,
    ) -> Result<()> {
        connection
            .prepare_cached(
                "UPDATE messages SET to_recipients=?1,cc_recipients=?2,bcc_recipients=?3,rfc_references=?4 WHERE account_id=?5 AND id=?6",
            )?
            .execute(params![
                update.to,
                update.cc,
                update.bcc,
                update.references,
                message.account_id,
                message.message_id
            ])?;
        Ok(())
    }
}
