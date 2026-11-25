use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, Result};

use super::shared::{sql_placeholders, string_pair_row, ChunkedAccountQuery, ChunkedQuery};
use super::thread::{thread, SYSTEM_FOLDER_LABEL_IDS};
use crate::storage::{ThreadListRow, ThreadPageQuery, ThreadRepository};

pub(super) const THREAD_LIST_COLUMNS: &str = "t.account_id,t.id,t.subject,t.participants,t.latest_at,t.message_count,t.is_unread,t.is_starred,t.has_attachments,t.has_draft,t.sender_identity,t.recipient_identity,
                    COALESCE((SELECT m2.snippet FROM messages m2 WHERE m2.account_id=t.account_id AND m2.thread_id=t.id ORDER BY m2.sent_at DESC,m2.id DESC LIMIT 1),'')";

const THREAD_LIST_UNLABELLED_FORWARD: &str = "SELECT t.account_id,t.id,t.subject,t.participants,t.latest_at,t.message_count,t.is_unread,t.is_starred,t.has_attachments,t.has_draft,t.sender_identity,t.recipient_identity,COALESCE((SELECT m2.snippet FROM messages m2 WHERE m2.account_id=t.account_id AND m2.thread_id=t.id ORDER BY m2.sent_at DESC,m2.id DESC LIMIT 1),'') FROM threads t WHERE t.account_id=?1 ORDER BY t.latest_at DESC,t.id DESC LIMIT ?5";

const THREAD_LIST_UNLABELLED_FORWARD_CURSOR: &str = "SELECT t.account_id,t.id,t.subject,t.participants,t.latest_at,t.message_count,t.is_unread,t.is_starred,t.has_attachments,t.has_draft,t.sender_identity,t.recipient_identity,COALESCE((SELECT m2.snippet FROM messages m2 WHERE m2.account_id=t.account_id AND m2.thread_id=t.id ORDER BY m2.sent_at DESC,m2.id DESC LIMIT 1),'') FROM threads t WHERE t.account_id=?1 AND (t.latest_at,t.id)<(?3,?4) ORDER BY t.latest_at DESC,t.id DESC LIMIT ?5";

const THREAD_LIST_UNLABELLED_BACKWARD: &str = "SELECT t.account_id,t.id,t.subject,t.participants,t.latest_at,t.message_count,t.is_unread,t.is_starred,t.has_attachments,t.has_draft,t.sender_identity,t.recipient_identity,COALESCE((SELECT m2.snippet FROM messages m2 WHERE m2.account_id=t.account_id AND m2.thread_id=t.id ORDER BY m2.sent_at DESC,m2.id DESC LIMIT 1),'') FROM threads t WHERE t.account_id=?1 ORDER BY t.latest_at ASC,t.id ASC LIMIT ?5";

const THREAD_LIST_UNLABELLED_BACKWARD_CURSOR: &str = "SELECT t.account_id,t.id,t.subject,t.participants,t.latest_at,t.message_count,t.is_unread,t.is_starred,t.has_attachments,t.has_draft,t.sender_identity,t.recipient_identity,COALESCE((SELECT m2.snippet FROM messages m2 WHERE m2.account_id=t.account_id AND m2.thread_id=t.id ORDER BY m2.sent_at DESC,m2.id DESC LIMIT 1),'') FROM threads t WHERE t.account_id=?1 AND (t.latest_at,t.id)>(?3,?4) ORDER BY t.latest_at ASC,t.id ASC LIMIT ?5";

const THREAD_LIST_LABELLED_FORWARD: &str = "SELECT t.account_id,t.id,t.subject,t.participants,tl.latest_at,t.message_count,t.is_unread,t.is_starred,t.has_attachments,t.has_draft,t.sender_identity,t.recipient_identity,COALESCE((SELECT m2.snippet FROM messages m2 WHERE m2.account_id=t.account_id AND m2.thread_id=t.id ORDER BY m2.sent_at DESC,m2.id DESC LIMIT 1),'') FROM thread_labels tl CROSS JOIN threads t ON t.account_id=tl.account_id AND t.id=tl.thread_id WHERE tl.account_id=?1 AND tl.label_id=?2 ORDER BY tl.latest_at DESC,tl.thread_id DESC LIMIT ?5";

const THREAD_LIST_LABELLED_FORWARD_CURSOR: &str = "SELECT t.account_id,t.id,t.subject,t.participants,tl.latest_at,t.message_count,t.is_unread,t.is_starred,t.has_attachments,t.has_draft,t.sender_identity,t.recipient_identity,COALESCE((SELECT m2.snippet FROM messages m2 WHERE m2.account_id=t.account_id AND m2.thread_id=t.id ORDER BY m2.sent_at DESC,m2.id DESC LIMIT 1),'') FROM thread_labels tl CROSS JOIN threads t ON t.account_id=tl.account_id AND t.id=tl.thread_id WHERE tl.account_id=?1 AND tl.label_id=?2 AND (tl.latest_at,tl.thread_id)<(?3,?4) ORDER BY tl.latest_at DESC,tl.thread_id DESC LIMIT ?5";

const THREAD_LIST_LABELLED_BACKWARD: &str = "SELECT t.account_id,t.id,t.subject,t.participants,tl.latest_at,t.message_count,t.is_unread,t.is_starred,t.has_attachments,t.has_draft,t.sender_identity,t.recipient_identity,COALESCE((SELECT m2.snippet FROM messages m2 WHERE m2.account_id=t.account_id AND m2.thread_id=t.id ORDER BY m2.sent_at DESC,m2.id DESC LIMIT 1),'') FROM thread_labels tl CROSS JOIN threads t ON t.account_id=tl.account_id AND t.id=tl.thread_id WHERE tl.account_id=?1 AND tl.label_id=?2 ORDER BY tl.latest_at ASC,tl.thread_id ASC LIMIT ?5";

const THREAD_LIST_LABELLED_BACKWARD_CURSOR: &str = "SELECT t.account_id,t.id,t.subject,t.participants,tl.latest_at,t.message_count,t.is_unread,t.is_starred,t.has_attachments,t.has_draft,t.sender_identity,t.recipient_identity,COALESCE((SELECT m2.snippet FROM messages m2 WHERE m2.account_id=t.account_id AND m2.thread_id=t.id ORDER BY m2.sent_at DESC,m2.id DESC LIMIT 1),'') FROM thread_labels tl CROSS JOIN threads t ON t.account_id=tl.account_id AND t.id=tl.thread_id WHERE tl.account_id=?1 AND tl.label_id=?2 AND (tl.latest_at,tl.thread_id)>(?3,?4) ORDER BY tl.latest_at ASC,tl.thread_id ASC LIMIT ?5";

pub(super) struct ThreadEnrichmentScope<'a> {
    pub(super) account_id: &'a str,
    pub(super) includes_trashed_and_spammed: bool,
}

struct IndexedThreadRows<'a> {
    rows: &'a mut [ThreadListRow],
    positions: &'a HashMap<String, usize>,
}

impl IndexedThreadRows<'_> {
    fn index_for(&self, thread_id: &str, context: &str) -> usize {
        *self.positions.get(thread_id).expect(context)
    }
}

pub(super) fn enrich_thread_rows(
    connection: &Connection,
    scope: ThreadEnrichmentScope<'_>,
    mut rows: Vec<ThreadListRow>,
) -> Result<Vec<ThreadListRow>> {
    if rows.is_empty() {
        return Ok(rows);
    }

    let positions: HashMap<String, usize> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| (row.thread.id.clone(), index))
        .collect();
    let thread_ids: Vec<String> = rows.iter().map(|row| row.thread.id.clone()).collect();
    let id_refs: Vec<&str> = thread_ids.iter().map(String::as_str).collect();
    let chunked = ChunkedAccountQuery::new(connection, scope.account_id);

    if !scope.includes_trashed_and_spammed {
        apply_visible_message_counts(&chunked, &id_refs, &mut rows)?;
    }
    let mut indexed = IndexedThreadRows {
        rows: &mut rows,
        positions: &positions,
    };
    attach_user_labels(&chunked, &id_refs, &mut indexed)?;
    attach_system_labels(&chunked, &id_refs, &mut indexed)?;
    Ok(rows)
}

fn apply_visible_message_counts(
    chunked: &ChunkedAccountQuery<'_>,
    id_refs: &[&str],
    rows: &mut [ThreadListRow],
) -> Result<()> {
    let count_rows = chunked.query(
        ChunkedQuery {
            ids: id_refs,
            tail: &[],
            sql_for_placeholders: |placeholders| {
                format!(
                    "SELECT m.thread_id,COUNT(*)
                     FROM messages m
                     WHERE m.account_id=? AND m.thread_id IN ({placeholders})
                       AND NOT EXISTS (
                         SELECT 1 FROM message_labels ml
                         WHERE ml.account_id=m.account_id AND ml.message_id=m.id
                           AND ml.label_id IN ('TRASH','SPAM')
                       )
                     GROUP BY m.thread_id"
                )
            },
        },
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    )?;
    let counts: HashMap<String, i64> = count_rows.into_iter().collect();
    for row in rows {
        row.thread.message_count = counts.get(&row.thread.id).copied().unwrap_or_default();
    }
    Ok(())
}

fn attach_user_labels(
    chunked: &ChunkedAccountQuery<'_>,
    id_refs: &[&str],
    indexed: &mut IndexedThreadRows<'_>,
) -> Result<()> {
    let all_labels = chunked.query(
        ChunkedQuery {
            ids: id_refs,
            tail: &[],
            sql_for_placeholders: |placeholders| {
                format!(
                    "SELECT m.thread_id,l.name
                     FROM messages m
                     CROSS JOIN message_labels ml
                     CROSS JOIN labels l
                     WHERE m.account_id=? AND m.thread_id IN ({placeholders})
                       AND ml.account_id=m.account_id AND ml.message_id=m.id
                       AND l.account_id=ml.account_id AND l.id=ml.label_id AND l.kind='user'"
                )
            },
        },
        string_pair_row,
    )?;
    let mut seen = HashSet::new();
    for pair in all_labels {
        if seen.insert((pair.first.clone(), pair.second.clone())) {
            let index =
                indexed.index_for(&pair.first, "label query only returns requested threads");
            indexed.rows[index].label_indicators.push(pair.second);
        }
    }
    for row in indexed.rows.iter_mut() {
        row.label_indicators.sort();
    }
    Ok(())
}

fn attach_system_labels(
    chunked: &ChunkedAccountQuery<'_>,
    id_refs: &[&str],
    indexed: &mut IndexedThreadRows<'_>,
) -> Result<()> {
    let system_placeholders = sql_placeholders(SYSTEM_FOLDER_LABEL_IDS.len());
    let all_system_labels = chunked.query(
        ChunkedQuery {
            ids: id_refs,
            tail: &SYSTEM_FOLDER_LABEL_IDS,
            sql_for_placeholders: |placeholders| {
                format!(
                    "SELECT tl.thread_id,tl.label_id
                     FROM thread_labels tl
                     WHERE tl.account_id=? AND tl.thread_id IN ({placeholders})
                       AND tl.label_id IN ({system_placeholders})"
                )
            },
        },
        string_pair_row,
    )?;
    for pair in all_system_labels {
        let index = indexed.index_for(
            &pair.first,
            "system label query only returns requested threads",
        );
        indexed.rows[index].system_label_ids.push(pair.second);
    }
    for row in indexed.rows.iter_mut() {
        row.system_label_ids.sort();
    }
    Ok(())
}

fn thread_list_sql(query: &ThreadPageQuery<'_>) -> &'static str {
    match (
        query.label_id.is_some(),
        query.cursor.is_some(),
        query.direction,
    ) {
        (false, false, crate::sync::ThreadPageDirection::Forward) => THREAD_LIST_UNLABELLED_FORWARD,
        (false, true, crate::sync::ThreadPageDirection::Forward) => {
            THREAD_LIST_UNLABELLED_FORWARD_CURSOR
        }
        (false, false, crate::sync::ThreadPageDirection::Backward) => {
            THREAD_LIST_UNLABELLED_BACKWARD
        }
        (false, true, crate::sync::ThreadPageDirection::Backward) => {
            THREAD_LIST_UNLABELLED_BACKWARD_CURSOR
        }
        (true, false, crate::sync::ThreadPageDirection::Forward) => THREAD_LIST_LABELLED_FORWARD,
        (true, true, crate::sync::ThreadPageDirection::Forward) => {
            THREAD_LIST_LABELLED_FORWARD_CURSOR
        }
        (true, false, crate::sync::ThreadPageDirection::Backward) => THREAD_LIST_LABELLED_BACKWARD,
        (true, true, crate::sync::ThreadPageDirection::Backward) => {
            THREAD_LIST_LABELLED_BACKWARD_CURSOR
        }
    }
}

fn map_thread_list_row(row: &rusqlite::Row<'_>) -> Result<ThreadListRow> {
    Ok(ThreadListRow {
        thread: thread(row)?,
        snippet: row.get(12)?,
        label_indicators: Vec::new(),
        system_label_ids: Vec::new(),
    })
}

impl ThreadRepository {
    pub fn list_paginated(
        connection: &Connection,
        query: ThreadPageQuery<'_>,
    ) -> Result<Vec<ThreadListRow>> {
        Self::list_paginated_with_direction(
            connection,
            ThreadPageQuery {
                direction: crate::sync::ThreadPageDirection::Forward,
                ..query
            },
        )
    }

    pub fn list_paginated_with_direction(
        connection: &Connection,
        query: ThreadPageQuery<'_>,
    ) -> Result<Vec<ThreadListRow>> {
        let includes_trashed_and_spammed = query
            .label_id
            .is_none_or(crate::gmail::system_labels::is_trash_or_spam);
        let sql = thread_list_sql(&query);
        let mut statement = connection.prepare_cached(sql)?;
        let (cursor_at, cursor_id) = match query.cursor {
            Some(cursor) => (Some(cursor.latest_at), Some(cursor.thread_id)),
            None => (None, None),
        };
        let rows = statement
            .query_map(
                params![
                    query.account_id,
                    query.label_id,
                    cursor_at,
                    cursor_id,
                    query.limit
                ],
                map_thread_list_row,
            )?
            .collect::<Result<Vec<_>>>()?;
        let mut rows = enrich_thread_rows(
            connection,
            ThreadEnrichmentScope {
                account_id: query.account_id,
                includes_trashed_and_spammed: includes_trashed_and_spammed,
            },
            rows,
        )?;
        if query.direction == crate::sync::ThreadPageDirection::Backward {
            rows.reverse();
        }
        Ok(rows)
    }
}
