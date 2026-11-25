use tauri::Runtime;

use super::{
    dto::MessageBodyDto, ConversationDto, LabelDto, MutationResultDto, SyncStatusDto, ThreadPage,
    TraversalStatusDto,
};
use crate::ipc::{AccountIdRequest, AccountMessageRequest, AppServices, CommandPayload};
use bodies::{run_fetch_message_body, run_load_message_body};
use compose::{
    admit_compose, run_delete_draft, run_discard_compose_draft, run_hydrate_compose_draft,
    run_lookup_contacts, run_reply_context,
};
use labels::{
    run_create_label, run_delete_label, run_list_labels, run_recolor_label, run_rename_label,
};
use staging::{run_release_staged, run_stage_from_bytes, run_stage_from_path};
use threads::{
    mutate_thread, run_list_threads, run_load_conversation, run_mutate_messages,
    run_mutate_threads, run_read_traversal_status, run_trigger_sync, ThreadFlagChange,
};

mod bodies;
mod client;
mod compose;
mod labels;
mod staging;
mod threads;

pub use bodies::LoadMessageBodyRequest;
pub(crate) use client::{gmail_client_for, GmailClientDeps};
pub use compose::{
    ComposeAttachmentRequest, ComposeDraftCommand, ComposeDraftRequest, ComposeQueueAcceptance,
    DiscardDraftRequest, HydrateDraftRequest, HydratedComposeDraft, LookupContactsRequest,
    ReplyContextRequest,
};
pub use labels::{CreateLabelRequest, DeleteLabelRequest, RecolorLabelRequest, RenameLabelRequest};
pub use staging::{ReleaseStagedRequest, StageFromBytesRequest, StageFromPathRequest};
pub use threads::{
    AccountThreadRequest, ListThreadsRequest, LoadConversationRequest, MutateMessagesRequest,
    MutateThreadsRequest,
};

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
