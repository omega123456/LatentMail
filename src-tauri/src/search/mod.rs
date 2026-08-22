pub mod query;
pub mod scope;

use chrono::Utc;

use crate::storage::{SearchRepository, Storage};
use crate::sync::{
    ParsedSearchQueryDto, SearchPredicateDto, ThreadCursor, ThreadDto, ThreadPageDirection,
    ThreadSearchPage,
};

use query::{ParsedQuery, Predicate, PredicateKind};
use scope::SearchScope;

const DEFAULT_PAGE_SIZE: i64 = 50;

impl From<&Predicate> for SearchPredicateDto {
    fn from(predicate: &Predicate) -> Self {
        let negated = predicate.negated;
        match &predicate.kind {
            PredicateKind::Label(value) => Self::Label {
                value: value.clone(),
                negated,
            },
            PredicateKind::Unread => Self::Unread { negated },
            PredicateKind::Starred => Self::Starred { negated },
            PredicateKind::HasAttachment => Self::HasAttachment { negated },
            PredicateKind::SentBefore(at_seconds) => Self::SentBefore {
                at_seconds: *at_seconds,
                negated,
            },
            PredicateKind::SentAfter(at_seconds) => Self::SentAfter {
                at_seconds: *at_seconds,
                negated,
            },
            PredicateKind::TextExcludes(_) => Self::TextExcludes { negated },
        }
    }
}

fn to_dto(parsed: &ParsedQuery) -> ParsedSearchQueryDto {
    ParsedSearchQueryDto {
        has_text_term: parsed.has_text_term,
        from: parsed.from.clone(),
        to: parsed.to.clone(),
        subject: parsed.subject.clone(),
        includes: parsed.includes.clone(),
        excludes: parsed.excludes.clone(),
        predicates: parsed
            .predicates
            .iter()
            .map(SearchPredicateDto::from)
            .collect(),
    }
}

#[tauri::command]
pub async fn search_threads(
    storage: tauri::State<'_, Storage>,
    account_id: String,
    query: String,
    scope: Option<SearchScope>,
    cursor: Option<ThreadCursor>,
    direction: Option<ThreadPageDirection>,
    limit: Option<u32>,
) -> Result<ThreadSearchPage, String> {
    let parsed = query::parse(&query, Utc::now()).map_err(|error| error.to_string())?;
    if parsed.is_empty() {
        return Ok(ThreadSearchPage {
            items: Vec::new(),
            next_cursor: None,
            previous_cursor: None,
        });
    }

    let scope_filter = scope::resolve(&scope.unwrap_or(SearchScope::Default));
    let limit = limit.map_or(DEFAULT_PAGE_SIZE, |value| value as i64).max(1);
    let cursor_pair = cursor.map(|cursor| (cursor.latest_at, cursor.id));
    let has_cursor = cursor_pair.is_some();
    let direction = direction.unwrap_or_default();

    let mut rows = storage
        .run(move |connection| {
            let rows = SearchRepository::search_with_direction(
                connection,
                &account_id,
                &parsed,
                &scope_filter,
                cursor_pair,
                limit + 1,
                direction,
            )?;
            Ok(rows)
        })
        .await
        .map_err(|error| error.to_string())?;

    let has_more = rows.len() as i64 > limit;
    if has_more {
        match direction {
            ThreadPageDirection::Forward => rows.truncate(limit as usize),
            ThreadPageDirection::Backward => {
                rows.drain(..rows.len() - limit as usize);
            }
        }
    }
    let cursor_for = |row: &crate::storage::ThreadListRow| ThreadCursor {
        latest_at: row.thread.latest_at,
        id: row.thread.id.clone(),
    };
    let next_cursor = (direction == ThreadPageDirection::Forward && has_more)
        .then(|| rows.last().map(cursor_for))
        .flatten();
    let previous_cursor = ((direction == ThreadPageDirection::Backward && has_more)
        || (direction == ThreadPageDirection::Forward && has_cursor))
        .then(|| rows.first().map(cursor_for))
        .flatten();
    let items = rows
        .into_iter()
        .map(|row| {
            ThreadDto::from(row.thread).with_row_details(
                row.snippet,
                row.label_indicators,
                row.system_label_ids,
            )
        })
        .collect();
    Ok(ThreadSearchPage {
        items,
        next_cursor,
        previous_cursor,
    })
}

#[tauri::command]
pub async fn search_total(
    storage: tauri::State<'_, Storage>,
    account_id: String,
    query: String,
    scope: Option<SearchScope>,
) -> Result<i64, String> {
    let parsed = query::parse(&query, Utc::now()).map_err(|error| error.to_string())?;
    if parsed.is_empty() {
        return Ok(0);
    }
    let scope_filter = scope::resolve(&scope.unwrap_or(SearchScope::Default));
    storage
        .run(move |connection| {
            SearchRepository::count(connection, &account_id, &parsed, &scope_filter)
        })
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn parse_search_query(query: String) -> Result<ParsedSearchQueryDto, String> {
    let parsed = query::parse(&query, Utc::now()).map_err(|error| error.to_string())?;
    Ok(to_dto(&parsed))
}
