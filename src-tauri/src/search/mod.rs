pub mod query;
pub mod scope;

use chrono::Utc;

use crate::storage::{SearchRepository, Storage};
use crate::sync::{ParsedSearchQueryDto, SearchPredicateDto, ThreadCursor, ThreadDto, ThreadSearchPage};

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
        predicates: parsed.predicates.iter().map(SearchPredicateDto::from).collect(),
    }
}

#[tauri::command]
pub async fn search_threads(
    storage: tauri::State<'_, Storage>,
    account_id: String,
    query: String,
    scope: Option<SearchScope>,
    cursor: Option<ThreadCursor>,
    limit: Option<u32>,
) -> Result<ThreadSearchPage, String> {
    let parsed = query::parse(&query, Utc::now()).map_err(|error| error.to_string())?;
    if parsed.is_empty() {
        return Ok(ThreadSearchPage {
            items: Vec::new(),
            next_cursor: None,
            total: 0,
        });
    }

    let scope_filter = scope::resolve(&scope.unwrap_or(SearchScope::Default));
    let limit = limit.map_or(DEFAULT_PAGE_SIZE, |value| value as i64).max(1);
    let cursor_pair = cursor.map(|cursor| (cursor.latest_at, cursor.id));

    let (mut rows, total) = storage
        .run(move |connection| {
            let rows = SearchRepository::search(
                connection,
                &account_id,
                &parsed,
                &scope_filter,
                cursor_pair,
                limit + 1,
            )?;
            let total = SearchRepository::count(connection, &account_id, &parsed, &scope_filter)?;
            Ok((rows, total))
        })
        .await
        .map_err(|error| error.to_string())?;

    let next_cursor = if rows.len() as i64 > limit {
        rows.truncate(limit as usize);
        rows.last().map(|row| ThreadCursor {
            latest_at: row.thread.latest_at,
            id: row.thread.id.clone(),
        })
    } else {
        None
    };
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
        total,
    })
}

#[tauri::command]
pub fn parse_search_query(query: String) -> Result<ParsedSearchQueryDto, String> {
    let parsed = query::parse(&query, Utc::now()).map_err(|error| error.to_string())?;
    Ok(to_dto(&parsed))
}
