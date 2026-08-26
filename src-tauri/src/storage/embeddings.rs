use rusqlite::{params, Connection, Result};

pub struct EmbeddingRepository;

#[derive(Clone, Debug, PartialEq)]
pub struct MessageEmbedding {
    pub message_seq: i64,
    pub chunk_index: i64,
    pub vector: Vec<f32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmbeddingCounts {
    pub indexed_messages: i64,
    pub total_eligible_messages: i64,
    pub indexed_passages: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmbeddingBacklog {
    pub message_seq: i64,
    pub sender: String,
    pub recipients: String,
    pub subject: String,
    pub plain_body: Option<String>,
    pub html_body: Option<String>,
    pub truncated_body: Option<String>,
}

impl EmbeddingRepository {
    pub fn table_name(account_seq: i64) -> String {
        format!("message_vectors_{account_seq}")
    }

    pub(crate) fn account_seq(connection: &Connection, account_id: &str) -> Result<i64> {
        connection
            .prepare_cached("SELECT seq FROM accounts WHERE id=?1")?
            .query_row([account_id], |row| row.get(0))
    }

    fn trigger_definitions(sequence: i64) -> Vec<String> {
        let table = Self::table_name(sequence);
        let mut definitions = vec![
            format!("CREATE TRIGGER message_vectors_{sequence}_delete BEFORE DELETE ON messages WHEN old.account_id=(SELECT id FROM accounts WHERE seq={sequence}) BEGIN DELETE FROM {table} WHERE rowid IN (SELECT seq FROM message_embeddings WHERE account_id=old.account_id AND message_seq=old.seq); END"),
            format!("CREATE TRIGGER message_vectors_{sequence}_update BEFORE UPDATE OF subject,sender,recipients,plain_body,html_body,truncated_body ON messages WHEN old.account_id=(SELECT id FROM accounts WHERE seq={sequence}) AND (new.subject IS NOT old.subject OR new.sender IS NOT old.sender OR new.recipients IS NOT old.recipients OR new.truncated_body IS NOT old.truncated_body OR (old.truncated_body IS NULL AND (new.plain_body IS NOT old.plain_body OR new.html_body IS NOT old.html_body))) BEGIN DELETE FROM {table} WHERE rowid IN (SELECT seq FROM message_embeddings WHERE account_id=old.account_id AND message_seq=old.seq); DELETE FROM message_embeddings WHERE account_id=old.account_id AND message_seq=old.seq; END"),
            format!("CREATE TRIGGER message_vectors_{sequence}_excluded AFTER INSERT ON message_labels WHEN new.account_id=(SELECT id FROM accounts WHERE seq={sequence}) AND new.label_id IN ('TRASH','SPAM','DRAFT') BEGIN DELETE FROM {table} WHERE rowid IN (SELECT seq FROM message_embeddings WHERE account_id=new.account_id AND message_seq=(SELECT seq FROM messages WHERE account_id=new.account_id AND id=new.message_id)); DELETE FROM message_embeddings WHERE account_id=new.account_id AND message_seq=(SELECT seq FROM messages WHERE account_id=new.account_id AND id=new.message_id); END"),
        ];
        definitions.sort();
        definitions
    }

    fn matches_installed_definitions(connection: &Connection, sequence: i64) -> Result<bool> {
        let table = Self::table_name(sequence);
        let mut statement = connection.prepare_cached("SELECT COALESCE(sql,'') FROM sqlite_master WHERE name IN (?1,?1||'_delete',?1||'_update',?1||'_excluded') AND name<>?1 ORDER BY sql")?;
        let installed: Vec<String> = statement
            .query_map([&table], |row| row.get(0))?
            .collect::<Result<_>>()?;
        let table_present: i64 = connection
            .prepare_cached("SELECT COUNT(*) FROM sqlite_master WHERE name=?1")?
            .query_row([&table], |row| row.get(0))?;
        Ok(table_present == 1 && installed == Self::trigger_definitions(sequence))
    }

    pub fn create(connection: &Connection, account_id: &str, dimensions: i64) -> Result<()> {
        if dimensions <= 0 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let sequence = Self::account_seq(connection, account_id)?;
        let table = Self::table_name(sequence);
        if Self::matches_installed_definitions(connection, sequence)? {
            return Ok(());
        }
        connection.execute_batch(&format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS {table} USING vec0(embedding float[{dimensions}] distance_metric=cosine); DROP TRIGGER IF EXISTS message_vectors_{sequence}_delete; DROP TRIGGER IF EXISTS message_vectors_{sequence}_update; DROP TRIGGER IF EXISTS message_vectors_{sequence}_excluded; {};",
            Self::trigger_definitions(sequence).join("; ")
        ))
    }

    pub fn needs_rebuild(connection: &Connection, account_id: &str) -> Result<bool> {
        let table = Self::table_name(Self::account_seq(connection, account_id)?);
        let declaration: Option<String> = connection
            .prepare_cached("SELECT sql FROM sqlite_master WHERE name=?1")?
            .query_map([&table], |row| row.get(0))?
            .next()
            .transpose()?;
        Ok(declaration.is_some_and(|sql| !sql.contains("distance_metric=cosine")))
    }

    pub fn drop(connection: &Connection, account_id: &str) -> Result<()> {
        let sequence = Self::account_seq(connection, account_id)?;
        let table = Self::table_name(sequence);
        connection.execute_batch(&format!("DROP TRIGGER IF EXISTS message_vectors_{sequence}_delete; DROP TRIGGER IF EXISTS message_vectors_{sequence}_update; DROP TRIGGER IF EXISTS message_vectors_{sequence}_excluded; DROP TABLE IF EXISTS {table}"))?;
        connection.execute(
            "DELETE FROM message_embeddings WHERE account_id=?1",
            [account_id],
        )?;
        Ok(())
    }

    pub fn backlog(
        connection: &Connection,
        account_id: &str,
        limit: i64,
    ) -> Result<Vec<EmbeddingBacklog>> {
        let mut statement = connection.prepare_cached("SELECT m.seq,m.sender,m.recipients,m.subject,m.plain_body,m.html_body,m.truncated_body FROM messages m WHERE m.seq IN (SELECT k.seq FROM messages k WHERE k.account_id=?1 AND NOT EXISTS (SELECT 1 FROM message_embeddings e WHERE e.account_id=k.account_id AND e.message_seq=k.seq) AND NOT EXISTS (SELECT 1 FROM message_labels l WHERE l.account_id=k.account_id AND l.message_id=k.id AND l.label_id IN ('TRASH','SPAM','DRAFT')) LIMIT ?2)")?;
        let rows = statement
            .query_map(params![account_id, limit], |row| {
                Ok(EmbeddingBacklog {
                    message_seq: row.get(0)?,
                    sender: row.get(1)?,
                    recipients: row.get(2)?,
                    subject: row.get(3)?,
                    plain_body: row.get(4)?,
                    html_body: row.get(5)?,
                    truncated_body: row.get(6)?,
                })
            })?
            .collect();
        rows
    }

    pub fn count_indexed(connection: &Connection, account_id: &str) -> Result<i64> {
        connection.query_row(
            "SELECT COUNT(DISTINCT message_seq) FROM message_embeddings WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
    }

    pub fn count_total(connection: &Connection, account_id: &str) -> Result<i64> {
        connection
            .prepare_cached("SELECT (SELECT COUNT(*) FROM messages WHERE account_id=?1)-(SELECT COUNT(DISTINCT message_id) FROM message_labels WHERE account_id=?1 AND label_id IN ('TRASH','SPAM','DRAFT'))")?
            .query_row([account_id], |row| row.get(0))
    }

    pub fn count_passages(connection: &Connection, account_id: &str) -> Result<i64> {
        connection.query_row(
            "SELECT COUNT(*) FROM message_embeddings WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
    }

    pub fn counts(connection: &Connection, account_id: &str) -> Result<EmbeddingCounts> {
        Ok(EmbeddingCounts {
            indexed_messages: Self::count_indexed(connection, account_id)?,
            total_eligible_messages: Self::count_total(connection, account_id)?,
            indexed_passages: Self::count_passages(connection, account_id)?,
        })
    }

    pub fn write(
        connection: &Connection,
        account_id: &str,
        entries: &[MessageEmbedding],
    ) -> Result<()> {
        let table = Self::table_name(Self::account_seq(connection, account_id)?);
        let transaction = connection.unchecked_transaction()?;
        let delete_vectors = format!("DELETE FROM {table} WHERE rowid IN (SELECT seq FROM message_embeddings WHERE account_id=?1 AND message_seq=?2 AND chunk_index=?3)");
        let insert_vector = format!("INSERT INTO {table}(rowid,embedding) VALUES (?1,?2)");
        let mut delete_vector_statement = transaction.prepare_cached(&delete_vectors)?;
        let mut delete_metadata_statement = transaction.prepare_cached("DELETE FROM message_embeddings WHERE account_id=?1 AND message_seq=?2 AND chunk_index=?3")?;
        let mut insert_metadata_statement = transaction.prepare_cached(
            "INSERT INTO message_embeddings(account_id,message_seq,chunk_index) VALUES (?1,?2,?3)",
        )?;
        let mut insert_vector_statement = transaction.prepare_cached(&insert_vector)?;
        for entry in entries {
            delete_vector_statement.execute(params![
                account_id,
                entry.message_seq,
                entry.chunk_index
            ])?;
            delete_metadata_statement.execute(params![
                account_id,
                entry.message_seq,
                entry.chunk_index
            ])?;
            let bytes: Vec<u8> = entry
                .vector
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect();
            insert_metadata_statement.execute(params![
                account_id,
                entry.message_seq,
                entry.chunk_index
            ])?;
            insert_vector_statement.execute(params![transaction.last_insert_rowid(), bytes])?;
        }
        drop(delete_vector_statement);
        drop(delete_metadata_statement);
        drop(insert_vector_statement);
        drop(insert_metadata_statement);
        transaction.commit()
    }

    pub fn nearest(
        connection: &Connection,
        account_id: &str,
        vector: &[f32],
        limit: i64,
    ) -> Result<Vec<(i64, f64)>> {
        let table = Self::table_name(Self::account_seq(connection, account_id)?);
        let bytes: Vec<u8> = vector
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        let mut statement = connection.prepare_cached(&format!("SELECT e.message_seq,v.distance FROM {table} v JOIN message_embeddings e ON e.seq=v.rowid WHERE v.embedding MATCH ?1 AND k=?2 AND e.account_id=?3 ORDER BY v.distance"))?;
        let rows = statement
            .query_map(params![bytes, limit, account_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect();
        rows
    }
}
