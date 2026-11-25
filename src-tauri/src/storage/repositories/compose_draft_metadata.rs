use rusqlite::{params, Connection, OptionalExtension, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposeDraftMetadata {
    pub account_id: String,
    pub draft_id: String,
    pub mode: String,
    pub original_message_id: Option<String>,
    pub original_gmail_message_id: Option<String>,
    pub target_thread_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub rfc_references: Option<String>,
    pub boundary_version: i64,
    pub editable_body_fingerprint: Option<String>,
    pub quote_html: Option<String>,
    pub quote_plain: Option<String>,
}

pub struct ComposeDraftMetadataRepository;

impl ComposeDraftMetadataRepository {
    pub fn upsert(connection: &Connection, metadata: &ComposeDraftMetadata) -> Result<()> {
        connection.execute("INSERT INTO compose_draft_metadata (account_id,draft_id,mode,original_message_id,original_gmail_message_id,target_thread_id,in_reply_to,rfc_references,boundary_version,editable_body_fingerprint,quote_html,quote_plain) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(account_id,draft_id) DO UPDATE SET mode=excluded.mode,original_message_id=excluded.original_message_id,original_gmail_message_id=excluded.original_gmail_message_id,target_thread_id=excluded.target_thread_id,in_reply_to=excluded.in_reply_to,rfc_references=excluded.rfc_references,boundary_version=excluded.boundary_version,editable_body_fingerprint=excluded.editable_body_fingerprint,quote_html=excluded.quote_html,quote_plain=excluded.quote_plain", params![metadata.account_id,metadata.draft_id,metadata.mode,metadata.original_message_id,metadata.original_gmail_message_id,metadata.target_thread_id,metadata.in_reply_to,metadata.rfc_references,metadata.boundary_version,metadata.editable_body_fingerprint,metadata.quote_html,metadata.quote_plain])?;
        Ok(())
    }
    pub fn get(
        connection: &Connection,
        account_id: &str,
        draft_id: &str,
    ) -> Result<Option<ComposeDraftMetadata>> {
        connection.query_row("SELECT account_id,draft_id,mode,original_message_id,original_gmail_message_id,target_thread_id,in_reply_to,rfc_references,boundary_version,editable_body_fingerprint,quote_html,quote_plain FROM compose_draft_metadata WHERE account_id=?1 AND draft_id=?2", params![account_id,draft_id], |row| Ok(ComposeDraftMetadata { account_id: row.get(0)?, draft_id: row.get(1)?, mode: row.get(2)?, original_message_id: row.get(3)?, original_gmail_message_id: row.get(4)?, target_thread_id: row.get(5)?, in_reply_to: row.get(6)?, rfc_references: row.get(7)?, boundary_version: row.get(8)?, editable_body_fingerprint: row.get(9)?, quote_html: row.get(10)?, quote_plain: row.get(11)? })).optional()
    }
    pub fn remove(connection: &Connection, account_id: &str, draft_id: &str) -> Result<()> {
        connection.execute(
            "DELETE FROM compose_draft_metadata WHERE account_id=?1 AND draft_id=?2",
            params![account_id, draft_id],
        )?;
        Ok(())
    }
}
