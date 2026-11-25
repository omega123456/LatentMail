use serde::Deserialize;
use tauri::{Emitter, Runtime};

use crate::sync::dto::{
    message_body_dto, ImagePolicy, ImagePolicyTarget, MessageBodyDto, MessageBodyFetchedDto,
    MessageBodyInput,
};
use crate::{
    attachments::MessageTarget,
    ipc::{AccountMessageRequest, AppServices},
    sanitize,
    storage::{ConversationEntryScope, MessageBodyUpdate, MessageKey, MessageRepository, Storage},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadMessageBodyRequest {
    pub account_id: String,
    pub message_id: String,
    pub image_policy: Option<ImagePolicy>,
    pub entry_scope: Option<ConversationEntryScope>,
}

pub(super) async fn run_load_message_body(
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

pub(super) struct InlineDownloadTarget<'a> {
    pub(super) message_id: &'a str,
    pub(super) html: Option<&'a str>,
    pub(super) attachment_parts: &'a [crate::gmail::AttachmentPart],
}

pub(super) async fn download_inline_images(
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

struct StoredBodyStatus {
    html_presence: crate::storage::HtmlPresence,
    body_is_empty: bool,
    inline_images_pending: bool,
}

impl StoredBodyStatus {
    fn is_complete(&self) -> bool {
        let too_large = matches!(self.html_presence, crate::storage::HtmlPresence::TooLarge);
        let never_fetched = matches!(
            self.html_presence,
            crate::storage::HtmlPresence::NeverFetched
        );
        too_large || (!never_fetched && !self.body_is_empty && !self.inline_images_pending)
    }
}

struct FetchedBodyWrite {
    account_id: String,
    message_id: String,
    html_body: Option<String>,
    plain_body: Option<String>,
    html_presence: crate::storage::HtmlPresence,
    parts: Vec<crate::storage::InlinePart>,
    attachments: Vec<crate::storage::Attachment>,
}

async fn load_stored_body_status(
    storage: &Storage,
    request: &AccountMessageRequest,
) -> Result<StoredBodyStatus, String> {
    let account = request.account_id.clone();
    let id = request.message_id.clone();
    let status = string_try!(
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
                Ok(Some(StoredBodyStatus {
                    html_presence: message.html_presence,
                    body_is_empty: message.body_is_empty(),
                    inline_images_pending: inline_images_pending,
                }))
            })
            .await
    );
    status.ok_or_else(|| "Message is unavailable".to_owned())
}

async fn persist_fetched_body(storage: &Storage, write: FetchedBodyWrite) -> Result<(), String> {
    string_try!(
        storage
            .run(move |connection| {
                let transaction = connection.unchecked_transaction()?;
                let key = MessageKey {
                    account_id: &write.account_id,
                    message_id: &write.message_id,
                };
                MessageRepository::set_body(
                    &transaction,
                    key,
                    MessageBodyUpdate {
                        html_body: write.html_body.as_deref(),
                        plain_body: write.plain_body.as_deref(),
                        presence: write.html_presence,
                    },
                )?;
                MessageRepository::replace_inline_parts(&transaction, key, &write.parts)?;
                crate::storage::AttachmentRepository::replace_for_message(
                    &transaction,
                    key,
                    &write.attachments,
                )?;
                transaction.commit()
            })
            .await
    );
    Ok(())
}

async fn fetch_and_stage_body(
    client: &crate::gmail::GmailClient,
    request: &AccountMessageRequest,
    cache: Option<&crate::attachments::AttachmentCache>,
) -> Result<FetchedBodyWrite, String> {
    let message = string_try!(client.message(&request.message_id).await);
    let html_presence = fetched_html_presence(message.oversize, message.html_body.as_deref());
    let mut parts: Vec<_> = message
        .inline_parts
        .into_iter()
        .map(|part| crate::storage::InlinePart {
            content_id: part.content_id,
            mime_type: part.mime_type,
            bytes: part.bytes,
        })
        .collect();
    download_inline_images(
        client,
        InlineDownloadTarget {
            message_id: &request.message_id,
            html: message.html_body.as_deref(),
            attachment_parts: &message.attachment_parts,
        },
        &mut parts,
    )
    .await;
    let attachments =
        crate::sync::materialize::attachment_records_from_parts(&message.attachment_parts);
    if let Some(cache) = cache {
        crate::attachments::seed_cache(
            cache,
            MessageTarget {
                account_id: &request.account_id,
                message_id: &request.message_id,
            },
            &message.attachment_parts,
        );
    }
    Ok(FetchedBodyWrite {
        account_id: request.account_id.clone(),
        message_id: request.message_id.clone(),
        html_body: message.html_body,
        plain_body: message.plain_body,
        html_presence: html_presence,
        parts: parts,
        attachments: attachments,
    })
}

pub(super) async fn run_fetch_message_body<R: Runtime>(
    services: AppServices<'_, R>,
    request: AccountMessageRequest,
) -> Result<(), String> {
    let storage = services.storage()?;
    let engine = services.sync()?;
    let stored = load_stored_body_status(storage.inner(), &request).await?;
    if stored.is_complete() {
        return Ok(());
    }
    let client = services.gmail_client(&request.account_id).await?;
    let write = fetch_and_stage_body(&client, &request, engine.attachment_cache()).await?;
    persist_fetched_body(storage.inner(), write).await?;
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
