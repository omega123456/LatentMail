use rusqlite::{types::Value, Connection, Result};

use super::shared::SqlClause;
use super::thread::thread;
use super::thread_listing::{enrich_thread_rows, ThreadEnrichmentScope, THREAD_LIST_COLUMNS};
use crate::storage::{ThreadListRow, ThreadPageCursor};

pub struct SearchPageQuery<'a> {
    pub account_id: &'a str,
    pub parsed: &'a crate::search::query::ParsedQuery,
    pub scope: &'a crate::search::scope::ScopeFilter,
    pub cursor: Option<ThreadPageCursor>,
    pub limit: i64,
    pub direction: crate::sync::ThreadPageDirection,
}

pub struct SearchCountQuery<'a> {
    pub account_id: &'a str,
    pub parsed: &'a crate::search::query::ParsedQuery,
    pub scope: &'a crate::search::scope::ScopeFilter,
}

pub struct SearchRepository;

impl SearchRepository {
    pub fn search(
        connection: &Connection,
        query: SearchPageQuery<'_>,
    ) -> Result<Vec<ThreadListRow>> {
        Self::search_with_direction(
            connection,
            SearchPageQuery {
                direction: crate::sync::ThreadPageDirection::Forward,
                ..query
            },
        )
    }

    pub fn search_with_direction(
        connection: &Connection,
        query: SearchPageQuery<'_>,
    ) -> Result<Vec<ThreadListRow>> {
        let clause = search_query_sql(&query);
        let mut statement = connection.prepare_cached(&clause.sql)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(clause.values.iter()), |row| {
                Ok(ThreadListRow {
                    thread: thread(row)?,
                    snippet: row.get(12)?,
                    label_indicators: Vec::new(),
                    system_label_ids: Vec::new(),
                })
            })?
            .collect::<Result<Vec<_>>>()?;
        let mut rows = enrich_thread_rows(
            connection,
            ThreadEnrichmentScope {
                account_id: query.account_id,
                includes_trashed_and_spammed: query.scope.includes_trashed_and_spammed(),
            },
            rows,
        )?;
        if query.direction == crate::sync::ThreadPageDirection::Backward {
            rows.reverse();
        }
        Ok(rows)
    }

    pub fn count(connection: &Connection, query: SearchCountQuery<'_>) -> Result<i64> {
        let clause = search_predicate_sql(&query);
        let select_from = search_count_select_from(query.parsed.has_text_term);
        let sql = [select_from, clause.sql.as_str()].concat();
        let mut statement = connection.prepare_cached(&sql)?;
        statement.query_row(rusqlite::params_from_iter(clause.values.iter()), |row| {
            row.get(0)
        })
    }
}

fn search_query_sql(query: &SearchPageQuery<'_>) -> SqlClause {
    if query.parsed.has_text_term {
        return search_text_sql(query);
    }
    search_thread_driven_sql(query)
}

fn search_count_select_from(has_text_term: bool) -> &'static str {
    if has_text_term {
        return "SELECT COUNT(DISTINCT m.thread_id) FROM message_search JOIN messages m ON m.seq=message_search.rowid WHERE ";
    }
    "SELECT COUNT(DISTINCT m.thread_id) FROM messages m WHERE "
}

fn search_text_sql(query: &SearchPageQuery<'_>) -> SqlClause {
    let mut predicate = search_predicate_sql(&SearchCountQuery {
        account_id: query.account_id,
        parsed: query.parsed,
        scope: query.scope,
    });
    let (cursor_sql, order_sql) = match query.direction {
        crate::sync::ThreadPageDirection::Forward => (
            " AND (t.latest_at,t.id)<(?,?)",
            " ORDER BY t.latest_at DESC,t.id DESC LIMIT ?",
        ),
        crate::sync::ThreadPageDirection::Backward => (
            " AND (t.latest_at,t.id)>(?,?)",
            " ORDER BY t.latest_at ASC,t.id ASC LIMIT ?",
        ),
    };
    if let Some(cursor) = &query.cursor {
        predicate.sql.push_str(cursor_sql);
        predicate.values.push(Value::Integer(cursor.latest_at));
        predicate.values.push(Value::Text(cursor.thread_id.clone()));
    }
    predicate.values.push(Value::Integer(query.limit));
    let mut sql = String::from("SELECT ");
    sql.push_str(THREAD_LIST_COLUMNS);
    sql.push_str(" FROM message_search JOIN messages m ON m.seq=message_search.rowid JOIN threads t ON t.account_id=m.account_id AND t.id=m.thread_id WHERE ");
    sql.push_str(&predicate.sql);
    sql.push_str(" GROUP BY t.id");
    sql.push_str(order_sql);
    SqlClause {
        sql: sql,
        values: predicate.values,
    }
}

fn search_thread_driven_sql(query: &SearchPageQuery<'_>) -> SqlClause {
    let mut values = vec![Value::Text(query.account_id.to_owned())];
    let (cursor_sql, order_sql) = match query.direction {
        crate::sync::ThreadPageDirection::Forward => (
            " AND (t.latest_at,t.id)<(?,?)",
            " ORDER BY t.latest_at DESC,t.id DESC LIMIT ?",
        ),
        crate::sync::ThreadPageDirection::Backward => (
            " AND (t.latest_at,t.id)>(?,?)",
            " ORDER BY t.latest_at ASC,t.id ASC LIMIT ?",
        ),
    };
    let cursor_sql = match &query.cursor {
        Some(cursor) => {
            values.push(Value::Integer(cursor.latest_at));
            values.push(Value::Text(cursor.thread_id.clone()));
            cursor_sql
        }
        None => "",
    };
    let conditions = search_message_conditions(query.parsed, query.scope);
    values.extend(conditions.values);
    values.push(Value::Integer(query.limit));
    let mut sql = String::from("SELECT ");
    sql.push_str(THREAD_LIST_COLUMNS);
    sql.push_str(" FROM threads t WHERE t.account_id=?");
    sql.push_str(cursor_sql);
    sql.push_str(
        " AND EXISTS(SELECT 1 FROM messages m WHERE m.account_id=t.account_id AND m.thread_id=t.id",
    );
    sql.push_str(&conditions.sql);
    sql.push(')');
    sql.push_str(order_sql);
    SqlClause {
        sql: sql,
        values: values,
    }
}

fn search_predicate_sql(query: &SearchCountQuery<'_>) -> SqlClause {
    let mut sql = String::new();
    let mut values: Vec<Value> = Vec::new();
    if query.parsed.has_text_term {
        sql.push_str("message_search MATCH ? AND ");
        values.push(Value::Text(
            query.parsed.match_expression.clone().unwrap_or_default(),
        ));
    }
    sql.push_str("m.account_id=?");
    values.push(Value::Text(query.account_id.to_owned()));

    let conditions = search_message_conditions(query.parsed, query.scope);
    sql.push_str(&conditions.sql);
    values.extend(conditions.values);
    SqlClause {
        sql: sql,
        values: values,
    }
}

fn search_message_conditions(
    parsed: &crate::search::query::ParsedQuery,
    scope: &crate::search::scope::ScopeFilter,
) -> SqlClause {
    let mut sql = String::new();
    let mut values: Vec<Value> = Vec::new();
    if let Some(label) = &scope.required_label {
        sql.push_str(" AND EXISTS(SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id=?)");
        values.push(Value::Text(label.clone()));
    }
    if !scope.excluded_labels.is_empty() {
        let placeholders = vec!["?"; scope.excluded_labels.len()].join(",");
        sql.push_str(" AND NOT EXISTS(SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id IN (");
        sql.push_str(&placeholders);
        sql.push_str("))");
        for label in &scope.excluded_labels {
            values.push(Value::Text(label.clone()));
        }
    }
    for predicate in &parsed.predicates {
        let fragment = search_predicate_fragment(predicate);
        sql.push_str(" AND ");
        sql.push_str(&fragment.sql);
        values.extend(fragment.values);
    }
    SqlClause {
        sql: sql,
        values: values,
    }
}

fn search_predicate_fragment(predicate: &crate::search::query::Predicate) -> SqlClause {
    use crate::search::query::PredicateKind;
    let mut clause = match &predicate.kind {
        PredicateKind::Label(label) => SqlClause {
            sql: "EXISTS(SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id=?)".to_owned(),
            values: vec![Value::Text(label.clone())],
        },
        PredicateKind::Unread => SqlClause {
            sql: "m.is_unread=1".to_owned(),
            values: Vec::new(),
        },
        PredicateKind::Starred => SqlClause {
            sql: "m.is_starred=1".to_owned(),
            values: Vec::new(),
        },
        PredicateKind::HasAttachment => SqlClause {
            sql: "m.has_attachments=1".to_owned(),
            values: Vec::new(),
        },
        PredicateKind::SentBefore(cutoff) => SqlClause {
            sql: "m.sent_at<?".to_owned(),
            values: vec![Value::Integer(*cutoff)],
        },
        PredicateKind::SentAfter(cutoff) => SqlClause {
            sql: "m.sent_at>=?".to_owned(),
            values: vec![Value::Integer(*cutoff)],
        },
        PredicateKind::TextExcludes(expression) => SqlClause {
            sql: "NOT EXISTS(SELECT 1 FROM message_search WHERE message_search.rowid=m.seq AND message_search MATCH ?)"
                .to_owned(),
            values: vec![Value::Text(expression.clone())],
        },
    };
    if predicate.negated {
        clause.sql = format!("NOT ({})", clause.sql);
    }
    clause
}
