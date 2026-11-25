use rusqlite::{params, Connection, OptionalExtension, Result};

use super::MessageRepository;
use crate::storage::{InlinePart, InlinePartData, MessageBodyUpdate, MessageKey};

impl MessageRepository {
    pub fn set_truncated_body(
        connection: &Connection,
        message: MessageKey<'_>,
        truncated_body: Option<&str>,
    ) -> Result<()> {
        connection.execute(
            "UPDATE messages SET truncated_body=?1 WHERE account_id=?2 AND id=?3",
            params![truncated_body, message.account_id, message.message_id],
        )?;
        Ok(())
    }

    pub fn set_body(
        connection: &Connection,
        message: MessageKey<'_>,
        body: MessageBodyUpdate<'_>,
    ) -> Result<()> {
        connection.execute(
            "UPDATE messages SET html_body=?1, plain_body=?2, html_presence=?3 WHERE account_id=?4 AND id=?5",
            params![
                body.html_body,
                body.plain_body,
                body.presence.as_db_str(),
                message.account_id,
                message.message_id
            ],
        )?;
        Ok(())
    }

    pub fn replace_inline_parts(
        connection: &Connection,
        message: MessageKey<'_>,
        parts: &[InlinePart],
    ) -> Result<()> {
        connection
            .prepare_cached(
                "DELETE FROM message_inline_parts WHERE account_id=?1 AND message_id=?2",
            )?
            .execute(params![message.account_id, message.message_id])?;
        let mut statement = connection.prepare_cached(
            "INSERT INTO message_inline_parts (account_id,message_id,content_id,mime_type,bytes) VALUES (?1,?2,?3,?4,?5)",
        )?;
        for part in parts {
            statement.execute(params![
                message.account_id,
                message.message_id,
                part.content_id,
                part.mime_type,
                part.bytes
            ])?;
        }
        Ok(())
    }

    pub fn inline_parts(
        connection: &Connection,
        account_id: &str,
        message_id: &str,
    ) -> Result<Vec<InlinePart>> {
        let mut statement = connection.prepare("SELECT content_id,mime_type,bytes FROM message_inline_parts WHERE account_id=?1 AND message_id=?2")?;
        let parts = statement
            .query_map(params![account_id, message_id], |row| {
                Ok(InlinePart {
                    content_id: row.get(0)?,
                    mime_type: row.get(1)?,
                    bytes: row.get(2)?,
                })
            })?
            .collect();
        parts
    }

    pub fn inline_content_ids(
        connection: &Connection,
        account_id: &str,
        message_id: &str,
    ) -> Result<Vec<String>> {
        let mut statement = connection.prepare_cached(
            "SELECT content_id FROM message_inline_parts WHERE account_id=?1 AND message_id=?2",
        )?;
        let content_ids = statement
            .query_map(params![account_id, message_id], |row| row.get(0))?
            .collect();
        content_ids
    }

    pub fn inline_part(
        connection: &Connection,
        message: MessageKey<'_>,
        content_id: &str,
    ) -> Result<Option<InlinePartData>> {
        let mut statement = connection.prepare_cached(
            "SELECT mime_type,bytes FROM message_inline_parts
             WHERE account_id=?1 AND message_id=?2 AND content_id=?3",
        )?;
        statement
            .query_row(
                params![message.account_id, message.message_id, content_id],
                |row| {
                    Ok(InlinePartData {
                        mime_type: row.get(0)?,
                        bytes: row.get(1)?,
                    })
                },
            )
            .optional()
    }
}
