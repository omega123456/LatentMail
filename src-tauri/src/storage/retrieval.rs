use rusqlite::{params, Connection, Result};

use crate::storage::EmbeddingRepository;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RetrievalFilters {
    pub date_from: Option<i64>,
    pub date_to: Option<i64>,
    pub sender: Option<String>,
    pub recipient: Option<String>,
    pub folder: Option<String>,
    pub has_attachment: Option<bool>,
    pub is_read: Option<bool>,
    pub is_starred: Option<bool>,
}

impl RetrievalFilters {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CandidatePassage {
    pub message_seq: i64,
    pub chunk_index: i64,
    pub distance: f64,
    pub sent_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PassageSource {
    pub message_seq: i64,
    pub message_id: String,
    pub thread_id: String,
    pub sender: String,
    pub recipients: String,
    pub subject: String,
    pub sent_at: i64,
    pub plain_body: Option<String>,
    pub html_body: Option<String>,
    pub truncated_body: Option<String>,
}

pub struct RetrievalRepository;

const CANDIDATE_SQL: &str = "SELECT e.message_seq,e.chunk_index,v.distance,m.sent_at FROM {table} v CROSS JOIN message_embeddings e ON e.seq=v.rowid CROSS JOIN messages m ON m.seq=e.message_seq WHERE v.embedding MATCH ?1 AND k=?2 AND e.account_id=?3";

const FILTERED_CANDIDATE_SQL: &str = "{candidates} AND v.rowid IN (SELECT c.seq FROM message_embeddings c CROSS JOIN messages f ON f.seq=c.message_seq WHERE c.account_id=?3 AND (?4 IS NULL OR f.sent_at>=?4) AND (?5 IS NULL OR f.sent_at<=?5) AND (?6 IS NULL OR f.sender LIKE '%'||?6||'%') AND (?7 IS NULL OR f.recipients LIKE '%'||?7||'%') AND (?8 IS NULL OR EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.account_id=ml.account_id AND l.id=ml.label_id WHERE ml.account_id=f.account_id AND ml.message_id=f.id AND l.name=?8)) AND (?9 IS NULL OR f.has_attachments=?9) AND (?10 IS NULL OR f.is_unread=?10) AND (?11 IS NULL OR f.is_starred=?11))";

const SOURCES_SQL: &str = "SELECT m.seq,m.id,m.thread_id,m.sender,m.recipients,m.subject,m.sent_at,m.plain_body,m.html_body,m.truncated_body FROM json_each(?2) r CROSS JOIN messages m ON m.seq=r.value WHERE m.account_id=?1";

impl RetrievalRepository {
    pub fn candidate_sql(table: &str, filtered: bool) -> String {
        let candidates = CANDIDATE_SQL.replace("{table}", table);
        if filtered {
            FILTERED_CANDIDATE_SQL.replace("{candidates}", &candidates)
        } else {
            candidates
        }
    }

    pub fn candidates(
        connection: &Connection,
        account_id: &str,
        vector: &[f32],
        limit: i64,
        filters: &RetrievalFilters,
    ) -> Result<Vec<CandidatePassage>> {
        let table = EmbeddingRepository::table_name(EmbeddingRepository::account_seq(
            connection, account_id,
        )?);
        let bytes: Vec<u8> = vector
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        let filtered = !filters.is_empty();
        let mut statement = connection.prepare_cached(&Self::candidate_sql(&table, filtered))?;
        let read = |row: &rusqlite::Row<'_>| {
            Ok(CandidatePassage {
                message_seq: row.get(0)?,
                chunk_index: row.get(1)?,
                distance: row.get(2)?,
                sent_at: row.get(3)?,
            })
        };
        if filtered {
            return statement
                .query_map(
                    params![
                        bytes,
                        limit,
                        account_id,
                        filters.date_from,
                        filters.date_to,
                        filters.sender,
                        filters.recipient,
                        filters.folder,
                        filters.has_attachment,
                        filters.is_read.map(|read| !read),
                        filters.is_starred,
                    ],
                    read,
                )?
                .collect();
        }
        let rows = statement
            .query_map(params![bytes, limit, account_id], read)?
            .collect();
        rows
    }

    pub fn sources(
        connection: &Connection,
        account_id: &str,
        message_seqs: &[i64],
    ) -> Result<Vec<PassageSource>> {
        let requested = serde_json::Value::from(message_seqs).to_string();
        connection
            .prepare_cached(SOURCES_SQL)?
            .query_map(params![account_id, requested], |row| {
                Ok(PassageSource {
                    message_seq: row.get(0)?,
                    message_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    sender: row.get(3)?,
                    recipients: row.get(4)?,
                    subject: row.get(5)?,
                    sent_at: row.get(6)?,
                    plain_body: row.get(7)?,
                    html_body: row.get(8)?,
                    truncated_body: row.get(9)?,
                })
            })?
            .collect()
    }

    pub fn folder_names(connection: &Connection, account_id: &str) -> Result<Vec<String>> {
        connection
            .prepare_cached("SELECT name FROM labels WHERE account_id=?1 ORDER BY id")?
            .query_map([account_id], |row| row.get(0))?
            .collect()
    }
}
