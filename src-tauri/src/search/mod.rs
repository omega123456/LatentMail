pub mod query;
pub mod scope;

use chrono::Utc;
use serde::Deserialize;
use tauri::Runtime;

use crate::ipc::{AppServices, CommandPayload};
use crate::storage::{
    SearchCountQuery, SearchPageQuery, SearchRepository, Storage, ThreadPageCursor,
};
use crate::sync::{
    ParsedSearchQueryDto, SearchPredicateDto, ThreadCursor, ThreadDto, ThreadPageDirection,
    ThreadSearchPage,
};

use query::{ParsedQuery, Predicate, PredicateKind};
use scope::SearchScope;

impl From<&Predicate> for SearchPredicateDto {
    fn from(predicate: &Predicate) -> Self {
        let negated = predicate.negated;
        match &predicate.kind {
            PredicateKind::Label(value) => Self::Label {
                value: value.clone(),
                negated: negated,
            },
            PredicateKind::Unread => Self::Unread { negated },
            PredicateKind::Starred => Self::Starred { negated },
            PredicateKind::HasAttachment => Self::HasAttachment { negated },
            PredicateKind::SentBefore(at_seconds) => Self::SentBefore {
                at_seconds: *at_seconds,
                negated: negated,
            },
            PredicateKind::SentAfter(at_seconds) => Self::SentAfter {
                at_seconds: *at_seconds,
                negated: negated,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchThreadsRequest {
    pub account_id: String,
    pub query: String,
    pub scope: Option<SearchScope>,
    pub cursor: Option<ThreadCursor>,
    pub direction: Option<ThreadPageDirection>,
    pub limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTotalRequest {
    pub account_id: String,
    pub query: String,
    pub scope: Option<SearchScope>,
}

struct SearchPageSpec {
    page_size: usize,
    direction: ThreadPageDirection,
    has_cursor: bool,
}

fn build_search_page(
    mut rows: Vec<crate::storage::ThreadListRow>,
    spec: SearchPageSpec,
) -> ThreadSearchPage {
    let has_more = rows.len() > spec.page_size;
    if has_more {
        match spec.direction {
            ThreadPageDirection::Forward => rows.truncate(spec.page_size),
            ThreadPageDirection::Backward => {
                rows.drain(..rows.len() - spec.page_size);
            }
        }
    }
    let cursor_for = |row: &crate::storage::ThreadListRow| ThreadCursor {
        latest_at: row.thread.latest_at,
        id: row.thread.id.clone(),
    };
    let next_cursor = (spec.direction == ThreadPageDirection::Forward && has_more)
        .then(|| rows.last().map(cursor_for))
        .flatten();
    let previous_cursor = ((spec.direction == ThreadPageDirection::Backward && has_more)
        || (spec.direction == ThreadPageDirection::Forward && spec.has_cursor))
        .then(|| rows.first().map(cursor_for))
        .flatten();
    let items = rows.into_iter().map(ThreadDto::from_row).collect();
    ThreadSearchPage {
        items: items,
        next_cursor: next_cursor,
        previous_cursor: previous_cursor,
    }
}

pub async fn run_search_threads(
    storage: &Storage,
    request: SearchThreadsRequest,
) -> Result<ThreadSearchPage, String> {
    let SearchThreadsRequest {
        account_id,
        query,
        scope,
        cursor,
        direction,
        limit,
    } = request;
    let parsed = query::parse(&query, Utc::now()).map_err(|error| error.to_string())?;
    if parsed.is_empty() {
        return Ok(ThreadSearchPage {
            items: Vec::new(),
            next_cursor: None,
            previous_cursor: None,
        });
    }

    let scope_filter = scope::resolve(&scope.unwrap_or(SearchScope::Default));
    let limit = crate::sync::thread_page_limit(limit);
    let page_size = usize::try_from(limit).unwrap_or(usize::MAX);
    let cursor_pair = cursor.map(|cursor| ThreadPageCursor {
        latest_at: cursor.latest_at,
        thread_id: cursor.id,
    });
    let has_cursor = cursor_pair.is_some();
    let direction = direction.unwrap_or_default();

    let rows = storage
        .run(move |connection| {
            SearchRepository::search_with_direction(
                connection,
                SearchPageQuery {
                    account_id: &account_id,
                    parsed: &parsed,
                    scope: &scope_filter,
                    cursor: cursor_pair,
                    limit: i64::from(limit) + 1,
                    direction: direction,
                },
            )
        })
        .await
        .map_err(|error| error.to_string())?;

    Ok(build_search_page(
        rows,
        SearchPageSpec {
            page_size: page_size,
            direction: direction,
            has_cursor: has_cursor,
        },
    ))
}

pub async fn run_search_total(
    storage: &Storage,
    request: SearchTotalRequest,
) -> Result<i64, String> {
    let SearchTotalRequest {
        account_id,
        query,
        scope,
    } = request;
    let parsed = query::parse(&query, Utc::now()).map_err(|error| error.to_string())?;
    if parsed.is_empty() {
        return Ok(0);
    }
    let scope_filter = scope::resolve(&scope.unwrap_or(SearchScope::Default));
    storage
        .run(move |connection| {
            SearchRepository::count(
                connection,
                SearchCountQuery {
                    account_id: &account_id,
                    parsed: &parsed,
                    scope: &scope_filter,
                },
            )
        })
        .await
        .map_err(|error| error.to_string())
}

pub fn parse_query_dto(query: &str) -> Result<ParsedSearchQueryDto, String> {
    let parsed = query::parse(query, Utc::now()).map_err(|error| error.to_string())?;
    Ok(to_dto(&parsed))
}

#[tauri::command]
pub async fn search_threads<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<SearchThreadsRequest>,
) -> Result<ThreadSearchPage, String> {
    run_search_threads(services.storage()?.inner(), request).await
}

#[tauri::command]
pub async fn search_total<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<SearchTotalRequest>,
) -> Result<i64, String> {
    run_search_total(services.storage()?.inner(), request).await
}

#[tauri::command]
pub fn parse_search_query(query: String) -> Result<ParsedSearchQueryDto, String> {
    parse_query_dto(&query)
}
