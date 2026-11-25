use rusqlite::{params, Connection, OptionalExtension, Result};

use crate::storage::MessageKey;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub attachment_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
    pub position: i64,
}

pub struct AttachmentRepository;

impl AttachmentRepository {
    pub fn replace_for_message(
        connection: &Connection,
        message: MessageKey<'_>,
        attachments: &[Attachment],
    ) -> Result<()> {
        let existing = Self::for_message(connection, message.account_id, message.message_id)?;
        connection
            .prepare_cached(
                "DELETE FROM message_attachments WHERE account_id=?1 AND message_id=?2",
            )?
            .execute(params![message.account_id, message.message_id])?;
        let mut statement = connection.prepare_cached(
            "INSERT INTO message_attachments (account_id,message_id,attachment_id,filename,mime_type,size,position) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        )?;
        for attachment in attachments {
            let attachment_id = resolve_attachment_id(&existing, attachment);
            statement.execute(params![
                message.account_id,
                message.message_id,
                attachment_id,
                attachment.filename,
                attachment.mime_type,
                attachment.size,
                attachment.position
            ])?;
        }
        Ok(())
    }

    pub fn for_message(
        connection: &Connection,
        account_id: &str,
        message_id: &str,
    ) -> Result<Vec<Attachment>> {
        let mut statement = connection.prepare_cached(
            "SELECT attachment_id,filename,mime_type,size,position FROM message_attachments WHERE account_id=?1 AND message_id=?2 ORDER BY position",
        )?;
        statement
            .query_map(params![account_id, message_id], attachment)?
            .collect()
    }

    pub fn get(
        connection: &Connection,
        message: MessageKey<'_>,
        attachment_id: &str,
    ) -> Result<Option<Attachment>> {
        connection
            .query_row(
                "SELECT attachment_id,filename,mime_type,size,position FROM message_attachments WHERE account_id=?1 AND message_id=?2 AND attachment_id=?3",
                params![message.account_id, message.message_id, attachment_id],
                attachment,
            )
            .optional()
    }
}

fn resolve_attachment_id<'a>(existing: &'a [Attachment], attachment: &'a Attachment) -> &'a str {
    let matched = existing.iter().find(|previous| {
        previous.position == attachment.position
            && previous.filename == attachment.filename
            && previous.size == attachment.size
    });
    matched.map_or(attachment.attachment_id.as_str(), |previous| {
        previous.attachment_id.as_str()
    })
}

pub(super) fn attachment(row: &rusqlite::Row<'_>) -> Result<Attachment> {
    Ok(Attachment {
        attachment_id: row.get(0)?,
        filename: row.get(1)?,
        mime_type: row.get(2)?,
        size: row.get(3)?,
        position: row.get(4)?,
    })
}
