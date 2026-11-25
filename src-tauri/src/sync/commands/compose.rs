use serde::{Deserialize, Serialize};
use tauri::Runtime;

use crate::sync::mutations::DraftMessageRef;
use crate::{
    compose::{
        context::ReplyInput,
        drafts::DraftTarget,
        staging::{OwnerScope, PartLookup, StageAttachmentRequest, StageBytesRequest},
    },
    ipc::{AccountMessageRequest, AppServices},
    storage::{addresses::split_addresses, MessageRepository, Storage},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeDraftRequest {
    pub(super) session_id: String,
    pub(super) account_id: String,
    pub(super) draft_id: Option<String>,
    pub(super) from: String,
    pub(super) to: Vec<String>,
    pub(super) cc: Vec<String>,
    pub(super) bcc: Vec<String>,
    pub(super) subject: String,
    pub(super) html: String,
    pub(super) mode: String,
    pub(super) thread_id: Option<String>,
    pub(super) in_reply_to: Option<String>,
    pub(super) references: Vec<String>,
    pub(super) original_message_id: Option<String>,
    pub(super) original_gmail_message_id: Option<String>,
    pub(super) quote_html: Option<String>,
    pub(super) quote_plain: Option<String>,
    pub(super) editable_body_fingerprint: Option<String>,
    pub(super) attachments: Vec<ComposeAttachmentRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeDraftCommand {
    pub draft: ComposeDraftRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeAttachmentRequest {
    pub(super) id: String,
    pub(super) filename: String,
    pub(super) mime_type: String,
    pub(super) content_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeQueueAcceptance {
    pub(super) operation_id: String,
    pub(super) draft_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedComposeDraft {
    pub(super) session_id: String,
    pub(super) account_id: String,
    pub(super) draft_id: String,
    pub(super) from: String,
    pub(super) to: Vec<String>,
    pub(super) cc: Vec<String>,
    pub(super) bcc: Vec<String>,
    pub(super) subject: String,
    pub(super) html: String,
    pub(super) quote_html: Option<String>,
    pub(super) quote_plain: Option<String>,
    pub(super) mode: String,
    pub(super) thread_id: Option<String>,
    pub(super) in_reply_to: Option<String>,
    pub(super) references: Vec<String>,
    pub(super) original_message_id: Option<String>,
    pub(super) original_gmail_message_id: Option<String>,
    pub(super) attachments: Vec<crate::sync::dto::StagedAttachmentDto>,
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
pub struct ReplyContextRequest {
    pub account_id: String,
    pub message_id: String,
    pub account_email: String,
    pub reply_all: bool,
    pub forward: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupContactsRequest {
    pub account_id: String,
    pub query: String,
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

fn lookup_compose_parts(
    staging: &crate::compose::staging::Staging,
    request: &ComposeDraftRequest,
) -> Result<Vec<crate::compose::staging::StagedPart>, String> {
    let owners: Vec<&str> = request
        .draft_id
        .as_deref()
        .into_iter()
        .chain(std::iter::once(request.session_id.as_str()))
        .collect();
    request
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
        .map_err(|error| error.to_string())
}

fn build_draft_payload(
    request: ComposeDraftRequest,
    send: bool,
) -> crate::compose::drafts::DraftOperationPayload {
    crate::compose::drafts::DraftOperationPayload {
        mode: compose_operation_mode(send, request.draft_id.is_some()),
        draft_id: request.draft_id,
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
    }
}

pub(super) async fn admit_compose<R: Runtime>(
    services: AppServices<'_, R>,
    request: ComposeDraftRequest,
    send: bool,
) -> Result<ComposeQueueAcceptance, String> {
    let queue = services.queue()?;
    let storage = services.storage()?;
    let staging = services.staging()?;
    let coalescer = services.coalescer()?;
    let operation_id = crate::compose::drafts::generate_id(compose_operation_prefix(send));
    let parts = lookup_compose_parts(staging.inner(), &request)?;
    let account_id = request.account_id.clone();
    let draft_id = request.draft_id.clone();
    let entity_key = draft_id
        .clone()
        .unwrap_or_else(|| request.session_id.clone());
    let payload = build_draft_payload(request, send);
    let admission_services = crate::compose::drafts::AdmissionServices {
        queue: queue.inner(),
        storage: storage.inner(),
        staging: staging.inner(),
        coalescer: coalescer.inner(),
    };
    let admission = crate::compose::drafts::DraftAdmission {
        id: operation_id.clone(),
        account_id: account_id,
        entity_key: entity_key,
        payload: payload,
    };
    crate::compose::drafts::admit(&admission_services, admission, &parts).await?;
    Ok(ComposeQueueAcceptance {
        operation_id: operation_id,
        draft_id: draft_id,
    })
}

pub(super) async fn run_discard_compose_draft<R: Runtime>(
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

pub(super) struct HydratedAttachmentContext<'a> {
    pub(super) staging: &'a crate::compose::staging::Staging,
    pub(super) client: &'a crate::gmail::GmailClient,
    pub(super) account_id: &'a str,
    pub(super) draft_id: &'a str,
    pub(super) message_id: &'a str,
}

pub(super) async fn stage_hydrated_attachment(
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

async fn load_compose_metadata(
    storage: &Storage,
    account_id: &str,
    draft_id: &str,
) -> Result<Option<crate::storage::ComposeDraftMetadata>, String> {
    let account_id = account_id.to_owned();
    let draft_id = draft_id.to_owned();
    storage
        .run(move |connection| {
            crate::storage::ComposeDraftMetadataRepository::get(connection, &account_id, &draft_id)
        })
        .await
        .map_err(|error| error.to_string())
}

async fn remove_stale_compose_metadata(
    storage: &Storage,
    account_id: &str,
    draft_id: &str,
) -> Result<(), String> {
    let account = account_id.to_owned();
    let draft = draft_id.to_owned();
    storage
        .run(move |connection| {
            crate::storage::ComposeDraftMetadataRepository::remove(connection, &account, &draft)
        })
        .await
        .map_err(|error| error.to_string())
}

async fn stage_hydrated_attachments(
    context: &HydratedAttachmentContext<'_>,
    parts: &[crate::gmail::AttachmentPart],
) -> Result<Vec<crate::sync::dto::StagedAttachmentDto>, String> {
    let mut attachments = Vec::new();
    for part in parts {
        let staged = stage_hydrated_attachment(context, part).await?;
        attachments.push(staged.into());
    }
    Ok(attachments)
}

fn metadata_boundary_matches(
    metadata: Option<&crate::storage::ComposeDraftMetadata>,
    remote_html: &str,
) -> bool {
    let Some(value) = metadata else {
        return false;
    };
    if value.boundary_version != 1 {
        return false;
    }
    value
        .quote_html
        .as_deref()
        .and_then(|quote| remote_html.strip_suffix(quote))
        .is_some_and(|editable| value.editable_body_fingerprint.as_deref() == Some(editable))
}

struct HydratedDraftBuild {
    request: HydrateDraftRequest,
    message: crate::gmail::GmailMessage,
    metadata: Option<crate::storage::ComposeDraftMetadata>,
    attachments: Vec<crate::sync::dto::StagedAttachmentDto>,
}

fn build_hydrated_draft(build: HydratedDraftBuild) -> HydratedComposeDraft {
    let remote_html = build.message.html_body.unwrap_or_default();
    let quote_html = build
        .metadata
        .as_ref()
        .and_then(|value| value.quote_html.clone());
    let has_matching_metadata = build.metadata.is_some();
    let html = hydrated_editable_html(has_matching_metadata, quote_html.as_deref(), &remote_html);
    let metadata = build.metadata;
    HydratedComposeDraft {
        session_id: crate::compose::drafts::generate_id("compose"),
        account_id: build.request.account_id,
        draft_id: build.request.draft_id,
        from: build.message.sender,
        to: split_addresses(&build.message.to_recipients),
        cc: split_addresses(&build.message.cc_recipients),
        bcc: split_addresses(&build.message.bcc_recipients),
        subject: build.message.subject,
        html: html,
        quote_html: quote_html,
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
        attachments: build.attachments,
    }
}

pub(super) async fn run_hydrate_compose_draft<R: Runtime>(
    services: AppServices<'_, R>,
    request: HydrateDraftRequest,
) -> Result<HydratedComposeDraft, String> {
    let storage = services.storage()?;
    let staging = services.staging()?;
    let client = services.gmail_client(&request.account_id).await?;
    let draft = crate::compose::drafts::hydrate(&client, &request.draft_id)
        .await
        .map_err(|error| error.to_string())?;
    let metadata =
        load_compose_metadata(storage.inner(), &request.account_id, &request.draft_id).await?;
    let attachment_context = HydratedAttachmentContext {
        staging: staging.as_ref(),
        client: &client,
        account_id: &request.account_id,
        draft_id: &request.draft_id,
        message_id: &draft.message.id,
    };
    let attachments =
        stage_hydrated_attachments(&attachment_context, &draft.message.attachment_parts).await?;
    let remote_html = draft.message.html_body.as_deref().unwrap_or_default();
    let boundary_matches = metadata_boundary_matches(metadata.as_ref(), remote_html);
    if metadata.is_some() && !boundary_matches {
        remove_stale_compose_metadata(storage.inner(), &request.account_id, &request.draft_id)
            .await?;
    }
    Ok(build_hydrated_draft(HydratedDraftBuild {
        request: request,
        message: draft.message,
        metadata: boundary_matches.then_some(metadata).flatten(),
        attachments: attachments,
    }))
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

pub(super) async fn run_lookup_contacts(
    storage: &Storage,
    request: LookupContactsRequest,
) -> Result<Vec<crate::sync::dto::ContactSuggestionDto>, String> {
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
        .map(|contact| crate::sync::dto::ContactSuggestionDto {
            address: contact.address,
            display_name: contact.display_name,
        })
        .collect())
}

pub(super) async fn run_reply_context(
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

pub(super) async fn run_delete_draft<R: Runtime>(
    services: AppServices<'_, R>,
    request: AccountMessageRequest,
) -> Result<(), String> {
    let storage = services.storage()?;
    let client = services.gmail_client(&request.account_id).await?;
    crate::sync::mutations::delete_draft(
        storage.inner(),
        &client,
        DraftMessageRef {
            account_id: &request.account_id,
            message_id: &request.message_id,
        },
    )
    .await
}
