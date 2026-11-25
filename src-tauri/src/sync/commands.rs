use std::{collections::HashSet, sync::Arc};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use crate::{
    attachments::MessageTarget,
    auth::AuthService,
    compose::{
        context::ReplyInput,
        drafts::DraftTarget,
        staging::{
            OwnerScope, PartLookup, StageAttachmentRequest, StageBytesRequest, StagePathRequest,
        },
    },
    gmail::{labels::resolve_color, AccountClientConfig},
    ipc::{AccountIdRequest, AccountMessageRequest, AppServices, CommandPayload},
    sanitize,
    storage::{
        addresses::split_addresses, ConversationEntryScope, LabelColor, LabelKey, LabelNameCheck,
        LabelRepository, MessageBodyUpdate, MessageKey, MessageRepository, Storage, ThreadKey,
        ThreadPageCursor, ThreadPageQuery, ThreadRepository, TraversalCursorRepository,
        TraversalKind,
    },
};

use super::{
    announce::MailChangeAnnouncer,
    dto::{
        message_body_dto, message_dto, ImagePolicy, ImagePolicyTarget, MessageBodyDto,
        MessageBodyFetchedDto, MessageBodyInput, MessageDtoInput,
    },
    gmail_base_url,
    mutations::{DraftMessageRef, LabelDelta, ThreadMutation},
    triage::{self, LabelChange, MessagesChangeRequest, ThreadsChangeRequest},
    ConversationDto, LabelDto, MutationResultDto, SyncEngine, SyncStatusDto, ThreadCursor,
    ThreadDto, ThreadPage, ThreadPageDirection, TraversalStatusDto,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeDraftRequest {
    session_id: String,
    account_id: String,
    draft_id: Option<String>,
    from: String,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    subject: String,
    html: String,
    mode: String,
    thread_id: Option<String>,
    in_reply_to: Option<String>,
    references: Vec<String>,
    original_message_id: Option<String>,
    original_gmail_message_id: Option<String>,
    quote_html: Option<String>,
    quote_plain: Option<String>,
    editable_body_fingerprint: Option<String>,
    attachments: Vec<ComposeAttachmentRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeDraftCommand {
    pub draft: ComposeDraftRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeAttachmentRequest {
    id: String,
    filename: String,
    mime_type: String,
    content_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeQueueAcceptance {
    operation_id: String,
    draft_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedComposeDraft {
    session_id: String,
    account_id: String,
    draft_id: String,
    from: String,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    subject: String,
    html: String,
    quote_html: Option<String>,
    quote_plain: Option<String>,
    mode: String,
    thread_id: Option<String>,
    in_reply_to: Option<String>,
    references: Vec<String>,
    original_message_id: Option<String>,
    original_gmail_message_id: Option<String>,
    attachments: Vec<super::dto::StagedAttachmentDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardDraftRequest {
    pub account_id: String,
    pub draft_id: Option<String>,
    pub session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydrateDraftRequest {
    pub account_id: String,
    pub draft_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupContactsRequest {
    pub account_id: String,
    pub query: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyContextRequest {
    pub account_id: String,
    pub message_id: String,
    pub account_email: String,
    pub reply_all: bool,
    pub forward: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageFromPathRequest {
    pub account_id: String,
    pub owner: String,
    pub path: String,
    pub mime_type: String,
    pub content_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageFromBytesRequest {
    pub account_id: String,
    pub owner: String,
    pub filename: String,
    pub mime_type: String,
    pub content_id: Option<String>,
    pub bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStagedRequest {
    pub account_id: String,
    pub owner: String,
    pub id: String,
}

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
pub struct LoadMessageBodyRequest {
    pub account_id: String,
    pub message_id: String,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLabelRequest {
    pub account_id: String,
    pub name: String,
    pub color_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameLabelRequest {
    pub account_id: String,
    pub label_id: String,
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecolorLabelRequest {
    pub account_id: String,
    pub label_id: String,
    pub color_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLabelRequest {
    pub account_id: String,
    pub label_id: String,
}

fn compose_operation_prefix(send: bool) -> &'static str {
    if send {
        return "send";
    }
    "draft"
}

fn compose_operation_mode(
    send: bool,
    has_draft_id: bool,
) -> crate::compose::drafts::DraftOperationMode {
    if send {
        return crate::compose::drafts::DraftOperationMode::Send;
    }
    if has_draft_id {
        return crate::compose::drafts::DraftOperationMode::Update;
    }
    crate::compose::drafts::DraftOperationMode::Create
}

async fn admit_compose<R: Runtime>(
    services: AppServices<'_, R>,
    request: ComposeDraftRequest,
    send: bool,
) -> Result<ComposeQueueAcceptance, String> {
    let queue = services.queue()?;
    let storage = services.storage()?;
    let staging = services.staging()?;
    let coalescer = services.coalescer()?;
    let operation_id = crate::compose::drafts::generate_id(compose_operation_prefix(send));

    let owners: Vec<&str> = request
        .draft_id
        .as_deref()
        .into_iter()
        .chain(std::iter::once(request.session_id.as_str()))
        .collect();
    let parts = request
        .attachments
        .iter()
        .map(|part| {
            staging.part(PartLookup {
                account_id: &request.account_id,
                owners: &owners,
                id: &part.id,
                filename: part.filename.clone(),
                mime_type: part.mime_type.clone(),
                content_id: part.content_id.clone(),
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let payload = crate::compose::drafts::DraftOperationPayload {
        mode: compose_operation_mode(send, request.draft_id.is_some()),
        draft_id: request.draft_id.clone(),
        thread_id: request.thread_id,
        from: request.from,
        to: request.to,
        cc: request.cc,
        bcc: request.bcc,
        subject: request.subject,
        html: request.html,
        quote_html: request.quote_html,
        in_reply_to: request.in_reply_to,
        references: request.references,
        metadata_mode: request.mode,
        original_message_id: request.original_message_id,
        original_gmail_message_id: request.original_gmail_message_id,
        editable_body_fingerprint: request.editable_body_fingerprint,
        quote_plain: request.quote_plain,
        coalescing_generation: 0,
    };
    let admission_services = crate::compose::drafts::AdmissionServices {
        queue: queue.inner(),
        storage: storage.inner(),
        staging: staging.inner(),
        coalescer: coalescer.inner(),
    };
    let admission = crate::compose::drafts::DraftAdmission {
        id: operation_id.clone(),
        account_id: request.account_id,
        entity_key: request
            .draft_id
            .clone()
            .unwrap_or(request.session_id.clone()),
        payload: payload,
    };
    crate::compose::drafts::admit(&admission_services, admission, &parts).await?;
    Ok(ComposeQueueAcceptance {
        operation_id: operation_id,
        draft_id: request.draft_id,
    })
}

async fn run_discard_compose_draft<R: Runtime>(
    services: AppServices<'_, R>,
    request: DiscardDraftRequest,
) -> Result<(), String> {
    let storage = services.storage()?;
    let staging = services.staging()?;
    storage
        .run({
            let account_id = request.account_id.clone();
            let session_id = request.session_id.clone();
            move |connection| {
                crate::storage::OperationRepository::discard_session_creates(
                    connection,
                    &account_id,
                    &session_id,
                )
            }
        })
        .await
        .map_err(|error| error.to_string())?;
    let Some(draft_id) = request.draft_id else {
        let _ = staging.release_owner(&request.account_id, &request.session_id);
        return Ok(());
    };
    let client = services.gmail_client(&request.account_id).await?;
    crate::compose::drafts::delete(
        &client,
        storage.inner(),
        DraftTarget {
            account_id: &request.account_id,
            draft_id: &draft_id,
        },
    )
    .await?;
    let _ = staging.release_owner(&request.account_id, &draft_id);
    let _ = staging.release_owner(&request.account_id, &request.session_id);
    Ok(())
}

struct HydratedAttachmentContext<'a> {
    staging: &'a crate::compose::staging::Staging,
    client: &'a crate::gmail::GmailClient,
    account_id: &'a str,
    draft_id: &'a str,
    message_id: &'a str,
}

async fn stage_hydrated_attachment(
    context: &HydratedAttachmentContext<'_>,
    part: &crate::gmail::AttachmentPart,
) -> Result<crate::compose::staging::StagedPart, String> {
    let scope = OwnerScope {
        account_id: context.account_id,
        owner: context.draft_id,
    };
    if let Some(bytes) = &part.inline_bytes {
        let descriptor = crate::compose::staging::StagedPart {
            id: crate::compose::drafts::generate_id("staged"),
            filename: part.filename.clone(),
            mime_type: part.mime_type.clone(),
            path: std::path::PathBuf::new(),
            content_id: None,
            size: 0,
        };
        return context
            .staging
            .stage_bytes(StageBytesRequest {
                scope: scope,
                descriptor: &descriptor,
                bytes: bytes,
            })
            .map_err(|error| error.to_string());
    }
    context
        .staging
        .stage_attachment(
            context.client,
            StageAttachmentRequest {
                scope: scope,
                source: crate::compose::staging::GmailAttachmentSource {
                    message_id: context.message_id,
                    attachment_id: &part.attachment_id,
                },
                descriptor: crate::compose::staging::NewStagedPart {
                    id: crate::compose::drafts::generate_id("staged"),
                    filename: part.filename.clone(),
                    mime_type: part.mime_type.clone(),
                    content_id: None,
                },
            },
        )
        .await
}

async fn run_hydrate_compose_draft<R: Runtime>(
    services: AppServices<'_, R>,
    request: HydrateDraftRequest,
) -> Result<HydratedComposeDraft, String> {
    let storage = services.storage()?;
    let staging = services.staging()?;
    let client = services.gmail_client(&request.account_id).await?;
    let draft = crate::compose::drafts::hydrate(&client, &request.draft_id)
        .await
        .map_err(|error| error.to_string())?;
    let metadata = storage
        .run({
            let account_id = request.account_id.clone();
            let draft_id = request.draft_id.clone();
            move |connection| {
                crate::storage::ComposeDraftMetadataRepository::get(
                    connection,
                    &account_id,
                    &draft_id,
                )
            }
        })
        .await
        .map_err(|error| error.to_string())?;
    let attachment_context = HydratedAttachmentContext {
        staging: staging.as_ref(),
        client: &client,
        account_id: &request.account_id,
        draft_id: &request.draft_id,
        message_id: &draft.message.id,
    };
    let mut attachments = Vec::new();
    for part in &draft.message.attachment_parts {
        let staged = stage_hydrated_attachment(&attachment_context, part).await?;
        attachments.push(staged.into());
    }
    let quote_html = metadata.as_ref().and_then(|value| value.quote_html.clone());
    let remote_html = draft.message.html_body.unwrap_or_default();
    let boundary_matches = metadata.as_ref().is_some_and(|value| {
        value.boundary_version == 1
            && quote_html
                .as_ref()
                .and_then(|quote| remote_html.strip_suffix(quote))
                .is_some_and(|editable| {
                    value.editable_body_fingerprint.as_deref() == Some(editable)
                })
    });
    if metadata.is_some() && !boundary_matches {
        let account = request.account_id.clone();
        let draft = request.draft_id.clone();
        storage
            .run(move |connection| {
                crate::storage::ComposeDraftMetadataRepository::remove(connection, &account, &draft)
            })
            .await
            .map_err(|error| error.to_string())?;
    }

    let metadata = boundary_matches.then_some(metadata).flatten();
    let html = hydrated_editable_html(boundary_matches, quote_html.as_deref(), &remote_html);
    Ok(HydratedComposeDraft {
        session_id: crate::compose::drafts::generate_id("compose"),
        account_id: request.account_id,
        draft_id: request.draft_id,
        from: draft.message.sender,
        to: split_addresses(&draft.message.to_recipients),
        cc: split_addresses(&draft.message.cc_recipients),
        bcc: split_addresses(&draft.message.bcc_recipients),
        subject: draft.message.subject,
        html: html,
        quote_html: boundary_matches.then_some(quote_html).flatten(),
        quote_plain: metadata
            .as_ref()
            .and_then(|value| value.quote_plain.clone()),
        mode: metadata
            .as_ref()
            .map_or_else(|| "draft".into(), |value| value.mode.clone()),
        thread_id: metadata
            .as_ref()
            .and_then(|value| value.target_thread_id.clone()),
        in_reply_to: metadata
            .as_ref()
            .and_then(|value| value.in_reply_to.clone()),
        references: metadata
            .as_ref()
            .and_then(|value| value.rfc_references.clone())
            .map(|value| value.split_whitespace().map(str::to_owned).collect())
            .unwrap_or_default(),
        original_message_id: metadata
            .as_ref()
            .and_then(|value| value.original_message_id.clone()),
        original_gmail_message_id: metadata.and_then(|value| value.original_gmail_message_id),
        attachments: attachments,
    })
}

fn hydrated_editable_html(
    boundary_matches: bool,
    quote_html: Option<&str>,
    remote_html: &str,
) -> String {
    if boundary_matches {
        return quote_html
            .and_then(|quote| remote_html.strip_suffix(quote))
            .unwrap_or(remote_html)
            .to_owned();
    }
    remote_html.to_owned()
}

async fn run_list_labels(storage: &Storage, account_id: String) -> Result<Vec<LabelDto>, String> {
    let (labels, unread_counts) = string_try!(
        storage
            .run(move |connection| Ok((
                LabelRepository::list(connection, &account_id)?,
                LabelRepository::unread_thread_counts(connection, &account_id)?
            )))
            .await
    );
    Ok(labels
        .into_iter()
        .map(|label| {
            let unread_count = unread_counts.get(&label.id).copied().unwrap_or_default();
            LabelDto::new(label, unread_count)
        })
        .collect())
}

async fn run_lookup_contacts(
    storage: &Storage,
    request: LookupContactsRequest,
) -> Result<Vec<super::dto::ContactSuggestionDto>, String> {
    if request.query.trim().chars().count() < 2 {
        return Ok(Vec::new());
    }
    let contacts = string_try!(
        storage
            .run(move |connection| {
                crate::contacts::lookup(connection, &request.account_id, &request.query)
            })
            .await
    );
    Ok(contacts
        .into_iter()
        .map(|contact| super::dto::ContactSuggestionDto {
            address: contact.address,
            display_name: contact.display_name,
        })
        .collect())
}

async fn run_reply_context(
    storage: &Storage,
    request: ReplyContextRequest,
) -> Result<crate::compose::context::ReplyContext, String> {
    let context = string_try!(
        storage
            .run(move |connection| {
                MessageRepository::compose_context(
                    connection,
                    &request.account_id,
                    &request.message_id,
                )?
                .ok_or(rusqlite::Error::QueryReturnedNoRows)
            })
            .await
    );
    if request.forward {
        let attachments = context
            .attachments
            .iter()
            .map(|attachment| crate::compose::context::ReplyAttachment {
                id: attachment.attachment_id.clone(),
                filename: attachment.filename.clone(),
                mime_type: attachment.mime_type.clone(),
                size: attachment.size,
            })
            .collect::<Vec<_>>();
        return Ok(crate::compose::context::forward(
            &context.message,
            attachments,
        ));
    }
    Ok(crate::compose::context::reply(
        &context.message,
        ReplyInput {
            to: &context.recipient_roles.to,
            cc: &context.recipient_roles.cc,
            account_email: &request.account_email,
            all: request.reply_all,
            references: context.references.as_deref(),
            attachments: Vec::new(),
        },
    ))
}

fn run_stage_from_path(
    staging: &Arc<crate::compose::staging::Staging>,
    request: StageFromPathRequest,
) -> Result<super::dto::StagedAttachmentDto, String> {
    let id = crate::compose::drafts::generate_id("staged");
    let part = string_try!(staging.stage_path(StagePathRequest {
        scope: OwnerScope {
            account_id: &request.account_id,
            owner: &request.owner,
        },
        source: std::path::Path::new(&request.path),
        id: &id,
        mime_type: request.mime_type,
        content_id: request.content_id,
    }));
    Ok(part.into())
}

fn run_stage_from_bytes(
    staging: &Arc<crate::compose::staging::Staging>,
    request: StageFromBytesRequest,
) -> Result<super::dto::StagedAttachmentDto, String> {
    let id = crate::compose::drafts::generate_id("staged");
    let descriptor = crate::compose::staging::StagedPart {
        id: id,
        filename: request.filename,
        mime_type: request.mime_type,
        path: std::path::PathBuf::new(),
        content_id: request.content_id,
        size: 0,
    };
    let part = string_try!(staging.stage_bytes(StageBytesRequest {
        scope: OwnerScope {
            account_id: &request.account_id,
            owner: &request.owner,
        },
        descriptor: &descriptor,
        bytes: &request.bytes,
    }));
    Ok(part.into())
}

fn run_release_staged(
    staging: &Arc<crate::compose::staging::Staging>,
    request: ReleaseStagedRequest,
) -> Result<(), String> {
    string_try!(staging.remove_part(
        OwnerScope {
            account_id: &request.account_id,
            owner: &request.owner,
        },
        &request.id,
    ));
    Ok(())
}

async fn run_list_threads(
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

async fn run_load_conversation(
    storage: &Storage,
    request: LoadConversationRequest,
) -> Result<ConversationDto, String> {
    let image_policy = request.image_policy.unwrap_or_default();
    let (account_for_read, thread_for_read) =
        (request.account_id.clone(), request.thread_id.clone());
    let (messages, thread_subject, newest_body) = string_try!(
        storage
            .run(move |connection| {
                let messages = MessageRepository::list_conversation_metadata(
                    connection,
                    ThreadKey {
                        account_id: &account_for_read,
                        thread_id: &thread_for_read,
                    },
                    request.entry_scope.as_ref(),
                )?;
                let subject =
                    ThreadRepository::get(connection, &account_for_read, &thread_for_read)?
                        .map(|thread| thread.subject)
                        .unwrap_or_default();
                let newest_body = messages
                    .last()
                    .map(|stored| {
                        MessageRepository::conversation_body(
                            connection,
                            MessageKey {
                                account_id: &account_for_read,
                                message_id: &stored.message.id,
                            },
                            request.entry_scope.as_ref(),
                        )
                        .map(|body| (stored.message.id.clone(), stored.label_ids.clone(), body))
                    })
                    .transpose()?;
                Ok((messages, subject, newest_body))
            })
            .await
    );

    let mut message_dtos = Vec::with_capacity(messages.len());
    for stored in messages {
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
    if let Some((message_id, label_ids, Some(body_data))) = newest_body {
        let allow_remote = image_policy.allows(ImagePolicyTarget {
            label_ids: &label_ids,
            message_id: &body_data.message.id,
            sender: &body_data.message.sender,
        });
        let body = message_body_dto(MessageBodyInput {
            account_id: &request.account_id,
            message: &body_data.message,
            inline_content_ids: &body_data.inline_content_ids,
            allow_remote: allow_remote,
        });
        if let Some(dto) = message_dtos.iter_mut().find(|dto| dto.id == message_id) {
            dto.html_body = body.html_body;
            dto.plain_body = body.plain_body;
            dto.truncated = body.truncated;
            dto.remote_images_blocked = body.remote_images_blocked;
            dto.remote_images_allowed = body.remote_images_allowed;
            dto.inline_images_pending = body.inline_images_pending;
        }
    }

    Ok(ConversationDto {
        thread_id: request.thread_id,
        subject: thread_subject,
        messages: message_dtos,
    })
}

async fn run_load_message_body(
    storage: &Storage,
    request: LoadMessageBodyRequest,
) -> Result<MessageBodyDto, String> {
    let image_policy = request.image_policy.unwrap_or_default();
    let account_for_read = request.account_id.clone();
    let id_for_read = request.message_id.clone();
    let body = string_try!(
        storage
            .run(move |connection| {
                let labels =
                    MessageRepository::label_ids(connection, &account_for_read, &id_for_read)?;
                let body = MessageRepository::conversation_body(
                    connection,
                    MessageKey {
                        account_id: &account_for_read,
                        message_id: &id_for_read,
                    },
                    request.entry_scope.as_ref(),
                )?;
                Ok((labels, body))
            })
            .await
    );
    let (label_ids, Some(body_data)) = body else {
        return Err("Message is unavailable".to_owned());
    };
    let allow_remote = image_policy.allows(ImagePolicyTarget {
        label_ids: &label_ids,
        message_id: &body_data.message.id,
        sender: &body_data.message.sender,
    });
    Ok(message_body_dto(MessageBodyInput {
        account_id: &request.account_id,
        message: &body_data.message,
        inline_content_ids: &body_data.inline_content_ids,
        allow_remote: allow_remote,
    }))
}

struct InlineDownloadTarget<'a> {
    message_id: &'a str,
    html: Option<&'a str>,
    attachment_parts: &'a [crate::gmail::AttachmentPart],
}

async fn download_inline_images(
    client: &crate::gmail::GmailClient,
    target: InlineDownloadTarget<'_>,
    parts: &mut Vec<crate::storage::InlinePart>,
) {
    let referenced = target
        .html
        .map(sanitize::referenced_content_ids)
        .unwrap_or_default();
    for part in target.attachment_parts {
        let Some(content_id) = part
            .content_id
            .clone()
            .filter(|id| referenced.iter().any(|value| value == id))
        else {
            continue;
        };
        match client
            .attachment(target.message_id, &part.attachment_id)
            .await
        {
            Ok(bytes) => parts.push(crate::storage::InlinePart {
                content_id: content_id,
                mime_type: part.mime_type.clone(),
                bytes: bytes,
            }),
            Err(error) => {
                tracing::debug!(
                    "inline image {content_id} of {} failed: {error}",
                    target.message_id
                );
            }
        }
    }
}

async fn run_fetch_message_body<R: Runtime>(
    services: AppServices<'_, R>,
    request: AccountMessageRequest,
) -> Result<(), String> {
    let storage = services.storage()?;
    let engine = services.sync()?;
    let account = request.account_id.clone();
    let id = request.message_id.clone();
    let stored = string_try!(
        storage
            .run(move |connection| {
                let Some(message) = MessageRepository::get(connection, &account, &id)? else {
                    return Ok(None);
                };
                let held = MessageRepository::inline_content_ids(connection, &account, &id)?;
                let inline_images_pending = message
                    .html_body
                    .as_deref()
                    .map(sanitize::referenced_content_ids)
                    .unwrap_or_default()
                    .iter()
                    .any(|referenced| !held.iter().any(|content_id| content_id == referenced));
                Ok(Some((
                    message.html_presence,
                    message.body_is_empty(),
                    inline_images_pending,
                )))
            })
            .await
    )
    .ok_or_else(|| "Message is unavailable".to_owned())?;

    let already_complete = matches!(stored.0, crate::storage::HtmlPresence::TooLarge)
        || (!matches!(stored.0, crate::storage::HtmlPresence::NeverFetched)
            && !stored.1
            && !stored.2);
    if already_complete {
        return Ok(());
    }
    let client = services.gmail_client(&request.account_id).await?;
    let message = string_try!(client.message(&request.message_id).await);
    let html_presence = fetched_html_presence(message.oversize, message.html_body.as_deref());
    let html_body = message.html_body;
    let plain_body = message.plain_body;
    let mut parts = message
        .inline_parts
        .into_iter()
        .map(|part| crate::storage::InlinePart {
            content_id: part.content_id,
            mime_type: part.mime_type,
            bytes: part.bytes,
        })
        .collect::<Vec<_>>();
    download_inline_images(
        &client,
        InlineDownloadTarget {
            message_id: &request.message_id,
            html: html_body.as_deref(),
            attachment_parts: &message.attachment_parts,
        },
        &mut parts,
    )
    .await;
    let attachments =
        crate::sync::materialize::attachment_records_from_parts(&message.attachment_parts);
    if let Some(cache) = engine.attachment_cache() {
        crate::attachments::seed_cache(
            cache,
            MessageTarget {
                account_id: &request.account_id,
                message_id: &request.message_id,
            },
            &message.attachment_parts,
        );
    }
    let account_for_persist = request.account_id.clone();
    let message_for_persist = request.message_id.clone();
    string_try!(
        storage
            .run(move |connection| {
                let transaction = connection.unchecked_transaction()?;
                let key = MessageKey {
                    account_id: &account_for_persist,
                    message_id: &message_for_persist,
                };
                MessageRepository::set_body(
                    &transaction,
                    key,
                    MessageBodyUpdate {
                        html_body: html_body.as_deref(),
                        plain_body: plain_body.as_deref(),
                        presence: html_presence,
                    },
                )?;
                MessageRepository::replace_inline_parts(&transaction, key, &parts)?;
                crate::storage::AttachmentRepository::replace_for_message(
                    &transaction,
                    key,
                    &attachments,
                )?;
                transaction.commit()
            })
            .await
    );
    services
        .app()
        .emit(
            crate::events::MESSAGE_BODY_FETCHED,
            MessageBodyFetchedDto {
                account_id: request.account_id,
                message_id: request.message_id,
            },
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn fetched_html_presence(oversize: bool, html_body: Option<&str>) -> crate::storage::HtmlPresence {
    if oversize {
        return crate::storage::HtmlPresence::TooLarge;
    }
    crate::storage::HtmlPresence::from_fetched_body(html_body)
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

struct ThreadFlagChange {
    label_id: &'static str,
    present: bool,
}

async fn mutate_thread<R: Runtime>(
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

async fn run_trigger_sync<R: Runtime>(
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

async fn run_mutate_threads<R: Runtime>(
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

async fn run_mutate_messages<R: Runtime>(
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

async fn run_delete_draft<R: Runtime>(
    services: AppServices<'_, R>,
    request: AccountMessageRequest,
) -> Result<(), String> {
    let storage = services.storage()?;
    let client = services.gmail_client(&request.account_id).await?;
    super::mutations::delete_draft(
        storage.inner(),
        &client,
        DraftMessageRef {
            account_id: &request.account_id,
            message_id: &request.message_id,
        },
    )
    .await
}

pub(crate) struct GmailClientDeps<'a, R: Runtime> {
    pub app: &'a AppHandle<R>,
    pub auth: &'a AuthService,
    pub engine: &'a SyncEngine,
}

pub(crate) async fn gmail_client_for<R: Runtime>(
    deps: GmailClientDeps<'_, R>,
    account_id: &str,
) -> Result<crate::gmail::GmailClient, String> {
    let token = deps.auth.refresh_access_token(deps.app, account_id).await?;
    let base_url = gmail_base_url();
    Ok(deps
        .engine
        .gmail_client(AccountClientConfig {
            account_id: account_id,
            access_token: token,
            base_url: base_url,
        })
        .await)
}

fn resolve_color_or_error(color_id: Option<&str>) -> Result<Option<LabelColor>, String> {
    match color_id {
        None => Ok(None),
        Some(id) => resolve_color(id)
            .map(|pair| {
                Some(LabelColor {
                    text: pair.text_color,
                    background: pair.background_color,
                })
            })
            .ok_or_else(|| format!("'{id}' is not a recognised label colour")),
    }
}

async fn read_label_dto(
    storage: &Storage,
    account_id: String,
    label_id: String,
) -> Result<Option<LabelDto>, String> {
    storage
        .run(move |connection| {
            let unread_counts = LabelRepository::unread_thread_counts(connection, &account_id)?;
            Ok(
                LabelRepository::get(connection, &account_id, &label_id)?.map(|label| {
                    let unread_count = unread_counts.get(&label.id).copied().unwrap_or_default();
                    LabelDto::new(label, unread_count)
                }),
            )
        })
        .await
        .map_err(|error| error.to_string())
}

async fn apply_create_label<R: Runtime>(
    services: &AppServices<'_, R>,
    request: CreateLabelRequest,
) -> Result<LabelDto, String> {
    let storage = services.storage()?;
    let color = resolve_color_or_error(request.color_id.as_deref())?;
    let account = request.account_id.clone();
    let trimmed = storage
        .run(move |connection| {
            Ok(LabelRepository::validate_name(
                connection,
                LabelNameCheck {
                    account_id: &account,
                    name: &request.name,
                    exclude_id: None,
                },
            ))
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    let client = services.gmail_client(&request.account_id).await?;
    let gmail_color = color.as_ref().map(|color| crate::gmail::LabelColorPair {
        text_color: color.text.clone(),
        background_color: color.background.clone(),
    });
    let created = client
        .create_label(&trimmed, gmail_color.as_ref())
        .await
        .map_err(|error| error.to_string())?;

    let stored = super::to_label(&request.account_id, &created);
    storage
        .run(move |connection| LabelRepository::upsert(connection, &stored))
        .await
        .map_err(|error| error.to_string())?;
    read_label_dto(storage.inner(), request.account_id, created.id)
        .await?
        .ok_or_else(|| "label vanished immediately after creation".to_owned())
}

async fn run_create_label<R: Runtime>(
    services: AppServices<'_, R>,
    request: CreateLabelRequest,
) -> Result<LabelDto, String> {
    let announcer = MailChangeAnnouncer::new(services.app(), &request.account_id);
    let outcome = apply_create_label(&services, request).await;
    announcer.announce(outcome)
}

async fn apply_rename_label<R: Runtime>(
    services: &AppServices<'_, R>,
    request: RenameLabelRequest,
) -> Result<LabelDto, String> {
    let storage = services.storage()?;
    let (account_for_validate, id_for_validate) =
        (request.account_id.clone(), request.label_id.clone());
    let trimmed = storage
        .run(move |connection| {
            Ok(LabelRepository::validate_name(
                connection,
                LabelNameCheck {
                    account_id: &account_for_validate,
                    name: &request.name,
                    exclude_id: Some(&id_for_validate),
                },
            ))
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    let client = services.gmail_client(&request.account_id).await?;
    client
        .update_label(
            &request.label_id,
            crate::gmail::labels::LabelUpdate {
                name: Some(&trimmed),
                color: None,
            },
        )
        .await
        .map_err(|error| error.to_string())?;

    let (account, id, new_name) = (
        request.account_id.clone(),
        request.label_id.clone(),
        trimmed,
    );
    storage
        .run(move |connection| {
            LabelRepository::rename(
                connection,
                LabelKey {
                    account_id: &account,
                    id: &id,
                },
                &new_name,
            )
        })
        .await
        .map_err(|error| error.to_string())?;
    read_label_dto(storage.inner(), request.account_id, request.label_id)
        .await?
        .ok_or_else(|| "label not found".to_owned())
}

async fn run_rename_label<R: Runtime>(
    services: AppServices<'_, R>,
    request: RenameLabelRequest,
) -> Result<LabelDto, String> {
    let announcer = MailChangeAnnouncer::new(services.app(), &request.account_id);
    let outcome = apply_rename_label(&services, request).await;
    announcer.announce(outcome)
}

async fn apply_recolor_label<R: Runtime>(
    services: &AppServices<'_, R>,
    request: RecolorLabelRequest,
) -> Result<LabelDto, String> {
    let storage = services.storage()?;
    let color = resolve_color(&request.color_id)
        .map(|pair| LabelColor {
            text: pair.text_color,
            background: pair.background_color,
        })
        .ok_or_else(|| format!("'{}' is not a recognised label colour", request.color_id))?;

    let client = services.gmail_client(&request.account_id).await?;
    let gmail_color = crate::gmail::LabelColorPair {
        text_color: color.text.clone(),
        background_color: color.background.clone(),
    };
    client
        .update_label(
            &request.label_id,
            crate::gmail::labels::LabelUpdate {
                name: None,
                color: Some(&gmail_color),
            },
        )
        .await
        .map_err(|error| error.to_string())?;

    let (account, id, stored_color) = (request.account_id.clone(), request.label_id.clone(), color);
    storage
        .run(move |connection| {
            LabelRepository::set_color(
                connection,
                LabelKey {
                    account_id: &account,
                    id: &id,
                },
                Some(&stored_color),
            )
        })
        .await
        .map_err(|error| error.to_string())?;
    read_label_dto(storage.inner(), request.account_id, request.label_id)
        .await?
        .ok_or_else(|| "label not found".to_owned())
}

async fn run_recolor_label<R: Runtime>(
    services: AppServices<'_, R>,
    request: RecolorLabelRequest,
) -> Result<LabelDto, String> {
    let announcer = MailChangeAnnouncer::new(services.app(), &request.account_id);
    let outcome = apply_recolor_label(&services, request).await;
    announcer.announce(outcome)
}

async fn apply_delete_label<R: Runtime>(
    services: &AppServices<'_, R>,
    request: DeleteLabelRequest,
) -> Result<(), String> {
    let storage = services.storage()?;
    let client = services.gmail_client(&request.account_id).await?;
    client
        .delete_label(&request.label_id)
        .await
        .map_err(|error| error.to_string())?;
    storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let touched: std::collections::HashSet<String> = LabelRepository::threads_with_label(
                &transaction,
                &request.account_id,
                &request.label_id,
            )?
            .into_iter()
            .collect();
            LabelRepository::delete(&transaction, &request.account_id, &request.label_id)?;
            ThreadRepository::recompute_many(&transaction, &request.account_id, &touched)?;
            transaction.commit()
        })
        .await
        .map_err(|error| error.to_string())
}

async fn run_delete_label<R: Runtime>(
    services: AppServices<'_, R>,
    request: DeleteLabelRequest,
) -> Result<(), String> {
    let announcer = MailChangeAnnouncer::new(services.app(), &request.account_id);
    let outcome = apply_delete_label(&services, request).await;
    announcer.announce(outcome)
}

async fn run_read_traversal_status(
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

#[tauri::command]
pub async fn save_compose_draft<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<ComposeDraftCommand>,
) -> Result<ComposeQueueAcceptance, String> {
    admit_compose(services, request.draft, false).await
}

#[tauri::command]
pub async fn send_compose_draft<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<ComposeDraftCommand>,
) -> Result<ComposeQueueAcceptance, String> {
    admit_compose(services, request.draft, true).await
}

#[tauri::command]
pub async fn discard_compose_draft<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<DiscardDraftRequest>,
) -> Result<(), String> {
    run_discard_compose_draft(services, request).await
}

#[tauri::command]
pub async fn hydrate_compose_draft<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<HydrateDraftRequest>,
) -> Result<HydratedComposeDraft, String> {
    run_hydrate_compose_draft(services, request).await
}

#[tauri::command]
pub async fn list_labels<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<AccountIdRequest>,
) -> Result<Vec<LabelDto>, String> {
    run_list_labels(services.storage()?.inner(), request.account_id).await
}

#[tauri::command]
pub async fn lookup_contacts<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<LookupContactsRequest>,
) -> Result<Vec<super::dto::ContactSuggestionDto>, String> {
    run_lookup_contacts(services.storage()?.inner(), request).await
}

#[tauri::command]
pub async fn reply_context<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<ReplyContextRequest>,
) -> Result<crate::compose::context::ReplyContext, String> {
    run_reply_context(services.storage()?.inner(), request).await
}

#[tauri::command]
pub async fn stage_attachment_from_path<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<StageFromPathRequest>,
) -> Result<super::dto::StagedAttachmentDto, String> {
    run_stage_from_path(services.staging()?.inner(), request)
}

#[tauri::command]
pub async fn stage_attachment_from_bytes<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<StageFromBytesRequest>,
) -> Result<super::dto::StagedAttachmentDto, String> {
    run_stage_from_bytes(services.staging()?.inner(), request)
}

#[tauri::command]
pub async fn release_staged_attachment<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<ReleaseStagedRequest>,
) -> Result<(), String> {
    run_release_staged(services.staging()?.inner(), request)
}

#[tauri::command]
pub async fn list_threads<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<ListThreadsRequest>,
) -> Result<ThreadPage, String> {
    run_list_threads(services.storage()?.inner(), request).await
}

#[tauri::command]
pub async fn load_conversation<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<LoadConversationRequest>,
) -> Result<ConversationDto, String> {
    run_load_conversation(services.storage()?.inner(), request).await
}

#[tauri::command]
pub async fn load_message_body<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<LoadMessageBodyRequest>,
) -> Result<MessageBodyDto, String> {
    run_load_message_body(services.storage()?.inner(), request).await
}

#[tauri::command]
pub async fn fetch_message_body<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<AccountMessageRequest>,
) -> Result<(), String> {
    run_fetch_message_body(services, request).await
}

#[tauri::command]
pub async fn star_thread<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<AccountThreadRequest>,
) -> Result<(), String> {
    mutate_thread(
        services,
        request,
        ThreadFlagChange {
            label_id: "STARRED",
            present: true,
        },
    )
    .await
}

#[tauri::command]
pub async fn unstar_thread<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<AccountThreadRequest>,
) -> Result<(), String> {
    mutate_thread(
        services,
        request,
        ThreadFlagChange {
            label_id: "STARRED",
            present: false,
        },
    )
    .await
}

#[tauri::command]
pub async fn mark_thread_read<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<AccountThreadRequest>,
) -> Result<(), String> {
    mutate_thread(
        services,
        request,
        ThreadFlagChange {
            label_id: "UNREAD",
            present: false,
        },
    )
    .await
}

#[tauri::command]
pub async fn mark_thread_unread<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<AccountThreadRequest>,
) -> Result<(), String> {
    mutate_thread(
        services,
        request,
        ThreadFlagChange {
            label_id: "UNREAD",
            present: true,
        },
    )
    .await
}

#[tauri::command]
pub async fn trigger_sync<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<AccountIdRequest>,
) -> Result<SyncStatusDto, String> {
    run_trigger_sync(services, request.account_id).await
}

#[tauri::command]
pub async fn read_sync_status<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<AccountIdRequest>,
) -> Result<SyncStatusDto, String> {
    Ok(services.sync()?.status(&request.account_id).await)
}

#[tauri::command]
pub async fn mutate_threads<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<MutateThreadsRequest>,
) -> Result<Vec<MutationResultDto>, String> {
    run_mutate_threads(services, request).await
}

#[tauri::command]
pub async fn mutate_messages<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<MutateMessagesRequest>,
) -> Result<(), String> {
    run_mutate_messages(services, request).await
}

#[tauri::command]
pub async fn delete_draft<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<AccountMessageRequest>,
) -> Result<(), String> {
    run_delete_draft(services, request).await
}

#[tauri::command]
pub async fn create_label<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<CreateLabelRequest>,
) -> Result<LabelDto, String> {
    run_create_label(services, request).await
}

#[tauri::command]
pub async fn rename_label<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<RenameLabelRequest>,
) -> Result<LabelDto, String> {
    run_rename_label(services, request).await
}

#[tauri::command]
pub async fn recolor_label<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<RecolorLabelRequest>,
) -> Result<LabelDto, String> {
    run_recolor_label(services, request).await
}

#[tauri::command]
pub async fn delete_label<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<DeleteLabelRequest>,
) -> Result<(), String> {
    run_delete_label(services, request).await
}

#[tauri::command]
pub async fn read_traversal_status<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<AccountIdRequest>,
) -> Result<TraversalStatusDto, String> {
    run_read_traversal_status(services.storage()?.inner(), request.account_id).await
}
