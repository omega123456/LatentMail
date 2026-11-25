use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Result};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelColor {
    pub text: String,
    pub background: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub account_id: String,
    pub id: String,
    pub name: String,
    pub kind: String,
    pub color: Option<LabelColor>,
    pub message_count: i64,
}

const RESERVED_LABEL_PREFIX: &str = "CATEGORY_";

const RESERVED_LABEL_NAMES: &[&str] = &[
    "INBOX",
    "SENT",
    "DRAFT",
    "TRASH",
    "SPAM",
    "STARRED",
    "UNREAD",
    "IMPORTANT",
    "CHAT",
];

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LabelNameError {
    #[error("label name cannot be empty")]
    Empty,
    #[error("label name must be 100 characters or fewer")]
    TooLong,
    #[error("label name cannot start with a reserved system prefix")]
    ReservedPrefix,
    #[error("label name cannot contain \\, *, or %")]
    ForbiddenCharacters,
    #[error("a label with this name already exists")]
    Duplicate,
}

const UNREAD_THREADS_PER_LABEL: &str = "SELECT tl.label_id,COUNT(*)
     FROM threads t
     CROSS JOIN thread_labels tl
       ON tl.account_id=t.account_id AND tl.thread_id=t.id
     WHERE t.account_id=?1 AND t.is_unread=1
     GROUP BY tl.label_id";

pub struct LabelKey<'a> {
    pub account_id: &'a str,
    pub id: &'a str,
}

pub struct LabelNameCheck<'a> {
    pub account_id: &'a str,
    pub name: &'a str,
    pub exclude_id: Option<&'a str>,
}

pub struct LabelRepository;

impl LabelRepository {
    pub fn upsert(connection: &Connection, label: &Label) -> Result<()> {
        let (color_text, color_background) = match &label.color {
            Some(color) => (Some(color.text.as_str()), Some(color.background.as_str())),
            None => (None, None),
        };
        connection.prepare_cached("INSERT INTO labels (account_id,id,name,kind,color_text,color_background,message_count) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(account_id,id) DO UPDATE SET name=excluded.name,kind=excluded.kind,color_text=excluded.color_text,color_background=excluded.color_background,message_count=excluded.message_count")?.execute(params![label.account_id,label.id,label.name,label.kind,color_text,color_background,label.message_count])?;
        Ok(())
    }
    pub fn list(connection: &Connection, account_id: &str) -> Result<Vec<Label>> {
        let mut statement = connection.prepare_cached("SELECT account_id,id,name,kind,color_text,color_background,message_count FROM labels WHERE account_id=?1 ORDER BY name")?;
        statement.query_map([account_id], label)?.collect()
    }
    pub fn get(connection: &Connection, account_id: &str, id: &str) -> Result<Option<Label>> {
        connection.query_row("SELECT account_id,id,name,kind,color_text,color_background,message_count FROM labels WHERE account_id=?1 AND id=?2", params![account_id, id], label).optional()
    }

    pub fn unread_thread_counts(
        connection: &Connection,
        account_id: &str,
    ) -> Result<HashMap<String, i64>> {
        let mut statement = connection.prepare_cached(UNREAD_THREADS_PER_LABEL)?;
        let counts = statement.query_map([account_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        counts.collect()
    }

    pub fn ensure_placeholder(connection: &Connection, account_id: &str, id: &str) -> Result<()> {
        connection
            .prepare_cached(
                "INSERT OR IGNORE INTO labels (account_id,id,name,kind,color_text,color_background,message_count) VALUES (?1,?2,?2,'system',NULL,NULL,0)",
            )?
            .execute(params![account_id, id])?;
        Ok(())
    }

    pub fn validate_name(
        connection: &Connection,
        check: LabelNameCheck<'_>,
    ) -> Result<String, LabelNameError> {
        let trimmed = check.name.trim();
        if trimmed.is_empty() {
            return Err(LabelNameError::Empty);
        }
        if trimmed.chars().count() > 100 {
            return Err(LabelNameError::TooLong);
        }
        if trimmed.contains(['\\', '*', '%']) {
            return Err(LabelNameError::ForbiddenCharacters);
        }
        let upper = trimmed.to_ascii_uppercase();
        if upper.starts_with(RESERVED_LABEL_PREFIX)
            || RESERVED_LABEL_NAMES.contains(&upper.as_str())
        {
            return Err(LabelNameError::ReservedPrefix);
        }
        let existing: Vec<String> = Self::list(connection, check.account_id)
            .unwrap_or_default()
            .into_iter()
            .filter(|existing| Some(existing.id.as_str()) != check.exclude_id)
            .map(|existing| existing.name)
            .collect();
        if existing
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(trimmed))
        {
            return Err(LabelNameError::Duplicate);
        }
        Ok(trimmed.to_owned())
    }
    pub fn rename(connection: &Connection, key: LabelKey<'_>, name: &str) -> Result<()> {
        connection.execute(
            "UPDATE labels SET name=?1 WHERE account_id=?2 AND id=?3",
            params![name, key.account_id, key.id],
        )?;
        Ok(())
    }
    pub fn set_color(
        connection: &Connection,
        key: LabelKey<'_>,
        color: Option<&LabelColor>,
    ) -> Result<()> {
        let (color_text, color_background) = match color {
            Some(color) => (Some(color.text.as_str()), Some(color.background.as_str())),
            None => (None, None),
        };
        connection.execute(
            "UPDATE labels SET color_text=?1, color_background=?2 WHERE account_id=?3 AND id=?4",
            params![color_text, color_background, key.account_id, key.id],
        )?;
        Ok(())
    }

    pub fn delete(connection: &Connection, account_id: &str, id: &str) -> Result<()> {
        connection
            .prepare_cached("DELETE FROM labels WHERE account_id=?1 AND id=?2")?
            .execute(params![account_id, id])?;
        Ok(())
    }

    pub fn threads_with_label(
        connection: &Connection,
        account_id: &str,
        label_id: &str,
    ) -> Result<Vec<String>> {
        let mut statement = connection.prepare_cached(
            "SELECT m.thread_id
             FROM message_labels ml
             CROSS JOIN messages m ON m.account_id=ml.account_id AND m.id=ml.message_id
             WHERE ml.account_id=?1 AND ml.label_id=?2",
        )?;
        let threads = statement.query_map(params![account_id, label_id], |row| row.get(0))?;
        threads.collect()
    }
}

pub(super) fn label(row: &rusqlite::Row<'_>) -> Result<Label> {
    let color_text: Option<String> = row.get(4)?;
    let color_background: Option<String> = row.get(5)?;
    let color = match (color_text, color_background) {
        (Some(text), Some(background)) => Some(LabelColor { text, background }),
        _ => None,
    };
    Ok(Label {
        account_id: row.get(0)?,
        id: row.get(1)?,
        name: row.get(2)?,
        kind: row.get(3)?,
        color: color,
        message_count: row.get(6)?,
    })
}
