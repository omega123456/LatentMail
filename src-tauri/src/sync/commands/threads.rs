use std::{collections::HashSet, sync::Arc};

use serde::Deserialize;
use tauri::Runtime;

use crate::sync::{
    announce::MailChangeAnnouncer,
    dto::{
        message_body_dto, message_dto, ImagePolicy, ImagePolicyTarget, MessageBodyInput,
        MessageDtoInput,
    },
    mutations::{LabelDelta, ThreadMutation},
    triage::{self, LabelChange, MessagesChangeRequest, ThreadsChangeRequest},
    ConversationDto, MutationResultDto, SyncStatusDto, ThreadCursor, ThreadDto, ThreadPage,
    ThreadPageDirection, TraversalStatusDto,
};
use crate::{
    ipc::AppServices,
    storage::{
        ConversationEntryScope, MessageKey, MessageRepository, Storage, ThreadKey,
        ThreadPageCursor, ThreadPageQuery, ThreadRepository, TraversalCursorRepository,
        TraversalKind,
    },
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListThreadsRequest {
    pub account_id: String,
    pub label_id: Option<String>,
    pub cursor: Option<ThreadCursor>,
    pub direction: Option<ThreadPageDirection>,
    pub limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadConversationRequest {
    pub account_id: String,
    pub thread_id: String,
    pub image_policy: Option<ImagePolicy>,
    pub entry_scope: Option<ConversationEntryScope>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountThreadRequest {
    pub account_id: String,
    pub thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutateThreadsRequest {
    pub account_id: String,
    pub thread_ids: Vec<String>,
    pub add: Vec<String>,
    pub remove: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutateMessagesRequest {
    pub account_id: String,
    pub message_ids: Vec<String>,
    pub add: Vec<String>,
    pub remove: Vec<String>,
}

pub(super) async fn run_list_threads(
    storage: &Storage,
    request: ListThreadsRequest,
) -> Result<ThreadPage, String> {
    let limit = crate::sync::thread_page_limit(request.limit);
    let page_size = usize::try_from(limit).unwrap_or(usize::MAX);
    let cursor = request.cursor.map(|cursor| ThreadPageCursor {
        latest_at: cursor.latest_at,
        thread_id: cursor.id,
    });
    let has_cursor = cursor.is_some();
    let direction = request.direction.unwrap_or_default();
    let mut rows = string_try!(
        storage
            .run(move |connection| {
                ThreadRepository::list_paginated_with_direction(
                    connection,
                    ThreadPageQuery {
                        account_id: &request.account_id,
                        label_id: request.label_id.as_deref(),
                        cursor: cursor,
                        limit: i64::from(limit) + 1,
                        direction: direction,
                    },
                )
            })
            .await
    );
    let has_more = rows.len() > page_size;
    if has_more {
        match direction {
            ThreadPageDirection::Forward => rows.truncate(page_size),
            ThreadPageDirection::Backward => {
                rows.drain(..rows.len() - page_size);
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
    let items = rows.into_iter().map(ThreadDto::from_row).collect();
    Ok(ThreadPage {
        items,
        next_cursor,
        previous_cursor,
    })
}

struct NewestConversationBody {
    message_id: String,
    label_ids: Vec<String>,
    body: crate::storage::ConversationBody,
}

struct LoadedConversation {
    messages: Vec<crate::storage::ConversationMessage>,
    subject: String,
    newest_body: Option<NewestConversationBody>,
}

struct BodyHydrationContext<'a> {
    account_id: &'a str,
    image_policy: &'a ImagePolicy,
}

struct ConversationQuery {
    account_id: String,
    thread_id: String,
    entry_scope: Option<ConversationEntryScope>,
}

fn read_newest_conversation_body(
    connection: &rusqlite::Connection,
    query: &ConversationQuery,
    newest: &crate::storage::ConversationMessage,
) -> rusqlite::Result<Option<NewestConversationBody>> {
    let body = MessageRepository::conversation_body(
        connection,
        MessageKey {
            account_id: &query.account_id,
            message_id: &newest.message.id,
        },
        query.entry_scope.as_ref(),
    )?;
    Ok(body.map(|body_data| NewestConversationBody {
        message_id: newest.message.id.clone(),
        label_ids: newest.label_ids.clone(),
        body: body_data,
    }))
}

fn read_conversation_from_connection(
    connection: &rusqlite::Connection,
    query: &ConversationQuery,
) -> rusqlite::Result<LoadedConversation> {
    let messages = MessageRepository::list_conversation_metadata(
        connection,
        ThreadKey {
            account_id: &query.account_id,
            thread_id: &query.thread_id,
        },
        query.entry_scope.as_ref(),
    )?;
    let subject = ThreadRepository::get(connection, &query.account_id, &query.thread_id)?
        .map(|thread| thread.subject)
        .unwrap_or_default();
    let newest_body = match messages.last() {
        Some(newest) => read_newest_conversation_body(connection, query, newest)?,
        None => None,
    };
    Ok(LoadedConversation {
        messages: messages,
        subject: subject,
        newest_body: newest_body,
    })
}

async fn load_conversation_from_storage(
    storage: &Storage,
    request: &LoadConversationRequest,
) -> Result<LoadedConversation, String> {
    let query = ConversationQuery {
        account_id: request.account_id.clone(),
        thread_id: request.thread_id.clone(),
        entry_scope: request.entry_scope.clone(),
    };
    let loaded = string_try!(
        storage
            .run(move |connection| read_conversation_from_connection(connection, &query))
            .await
    );
    Ok(loaded)
}

fn apply_newest_body(
    message_dtos: &mut [crate::sync::dto::MessageDto],
    newest: NewestConversationBody,
    context: &BodyHydrationContext<'_>,
) {
    let allow_remote = context.image_policy.allows(ImagePolicyTarget {
        label_ids: &newest.label_ids,
        message_id: &newest.body.message.id,
        sender: &newest.body.message.sender,
    });
    let body = message_body_dto(MessageBodyInput {
        account_id: context.account_id,
        message: &newest.body.message,
        inline_content_ids: &newest.body.inline_content_ids,
        allow_remote: allow_remote,
    });
    if let Some(dto) = message_dtos
        .iter_mut()
        .find(|dto| dto.id == newest.message_id)
    {
        dto.html_body = body.html_body;
        dto.plain_body = body.plain_body;
        dto.truncated = body.truncated;
        dto.remote_images_blocked = body.remote_images_blocked;
        dto.remote_images_allowed = body.remote_images_allowed;
        dto.inline_images_pending = body.inline_images_pending;
    }
}

pub(super) async fn run_load_conversation(
    storage: &Storage,
    request: LoadConversationRequest,
) -> Result<ConversationDto, String> {
    let image_policy = request.image_policy.clone().unwrap_or_default();
    let loaded = load_conversation_from_storage(storage, &request).await?;
    let mut message_dtos = Vec::with_capacity(loaded.messages.len());
    for stored in loaded.messages {
        let allow_remote = image_policy.allows(ImagePolicyTarget {
            label_ids: &stored.label_ids,
            message_id: &stored.message.id,
            sender: &stored.message.sender,
        });
        message_dtos.push(message_dto(MessageDtoInput {
            message: stored.message,
            recipient_roles: stored.recipient_roles,
            label_ids: stored.label_ids,
            sanitized: None,
            remote_images_allowed: allow_remote,
            draft_id: stored.draft_id,
            attachments: stored.attachments,
        }));
    }
    if let Some(newest) = loaded.newest_body {
        apply_newest_body(
            &mut message_dtos,
            newest,
            &BodyHydrationContext {
                account_id: &request.account_id,
                image_policy: &image_policy,
            },
        );
    }

    Ok(ConversationDto {
        thread_id: request.thread_id,
        subject: loaded.subject,
        messages: message_dtos,
    })
}

fn single_label_delta(label_id: &'static str, present: bool) -> LabelDelta {
    if present {
        return LabelDelta {
            additions: HashSet::from([label_id.to_owned()]),
            removals: HashSet::new(),
        };
    }
    LabelDelta {
        additions: HashSet::new(),
        removals: HashSet::from([label_id.to_owned()]),
    }
}

pub(super) struct ThreadFlagChange {
    pub(super) label_id: &'static str,
    pub(super) present: bool,
}

pub(super) async fn mutate_thread<R: Runtime>(
    services: AppServices<'_, R>,
    request: AccountThreadRequest,
    flag: ThreadFlagChange,
) -> Result<(), String> {
    let engine = services.sync()?;
    let client = services.gmail_client(&request.account_id).await?;
    string_try!(
        engine
            .mutate(ThreadMutation {
                account_id: request.account_id,
                client: client,
                thread_id: request.thread_id,
                labels: single_label_delta(flag.label_id, flag.present),
            })
            .await
    );
    Ok(())
}

pub(super) async fn run_trigger_sync<R: Runtime>(
    services: AppServices<'_, R>,
    account_id: String,
) -> Result<SyncStatusDto, String> {
    let auth = services.auth()?;
    let engine = Arc::clone(services.sync()?.inner());
    let client = services.gmail_client(&account_id).await?;
    tracing::info!(target: "sync", "{account_id}: manual sync requested");
    let result = engine.run_sync(&account_id, client).await;
    if result.is_err() {
        auth.invalidate_access_token(&account_id);
    }
    let status = engine.status(&account_id).await;
    string_try!(result);
    Ok(status)
}

pub(super) async fn run_mutate_threads<R: Runtime>(
    services: AppServices<'_, R>,
    request: MutateThreadsRequest,
) -> Result<Vec<MutationResultDto>, String> {
    let announcer = MailChangeAnnouncer::new(services.app(), &request.account_id);
    let outcome = match LabelChange::explicit(request.add, request.remove) {
        Ok(change) => {
            triage::apply_to_threads(
                &services,
                ThreadsChangeRequest {
                    account_id: request.account_id,
                    thread_ids: request.thread_ids,
                    change: change,
                },
            )
            .await
        }
        Err(error) => Err(error),
    };
    announcer.announce(outcome)
}

pub(super) async fn run_mutate_messages<R: Runtime>(
    services: AppServices<'_, R>,
    request: MutateMessagesRequest,
) -> Result<(), String> {
    let announcer = MailChangeAnnouncer::new(services.app(), &request.account_id);
    let outcome = match LabelChange::explicit(request.add, request.remove) {
        Ok(change) => {
            triage::apply_to_messages(
                &services,
                MessagesChangeRequest {
                    account_id: request.account_id,
                    message_ids: request.message_ids,
                    change: change,
                },
            )
            .await
        }
        Err(error) => Err(error),
    };
    announcer.announce(outcome)
}

pub(super) async fn run_read_traversal_status(
    storage: &Storage,
    account_id: String,
) -> Result<TraversalStatusDto, String> {
    let account = account_id.clone();
    let (backfill, reconciliation) = storage
        .run(move |connection| {
            let backfill =
                TraversalCursorRepository::get(connection, &account, TraversalKind::Backfill)?;
            let reconciliation = TraversalCursorRepository::get(
                connection,
                &account,
                TraversalKind::Reconciliation,
            )?;
            Ok((backfill, reconciliation))
        })
        .await
        .map_err(|error| error.to_string())?;
    Ok(TraversalStatusDto::most_recent(
        account_id,
        backfill,
        reconciliation,
    ))
}
