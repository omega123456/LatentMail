pub mod cache;
pub mod commands;
pub mod thumbnail;

pub use cache::{
    AttachmentCache, AttachmentDescriptor, AttachmentRef, CachedAttachment, CACHE_CEILING_BYTES,
};

use crate::gmail::AttachmentPart;

#[derive(Clone, Copy, Debug)]
pub struct MessageTarget<'a> {
    pub account_id: &'a str,
    pub message_id: &'a str,
}

pub struct RefetchRequest<'a> {
    pub account_id: &'a str,
    pub message_id: &'a str,
    pub record: &'a crate::storage::Attachment,
}

pub fn seed_cache(cache: &AttachmentCache, target: MessageTarget<'_>, parts: &[AttachmentPart]) {
    for part in parts {
        if let Some(bytes) = &part.inline_bytes {
            let _ = cache.write_bytes(
                AttachmentDescriptor {
                    target: AttachmentRef {
                        account_id: target.account_id,
                        message_id: target.message_id,
                        attachment_id: &part.attachment_id,
                    },
                    filename: &part.filename,
                    mime_type: &part.mime_type,
                },
                bytes,
            );
        }
    }
}

pub async fn refetch(
    cache: &AttachmentCache,
    client: &crate::gmail::GmailClient,
    request: RefetchRequest<'_>,
) -> Result<CachedAttachment, String> {
    let refreshed = client
        .message(request.message_id)
        .await
        .map_err(|error| error.to_string())?;
    let part = refreshed
        .attachment_parts
        .iter()
        .find(|part| part.filename == request.record.filename)
        .ok_or_else(|| "Attachment is no longer part of this message".to_owned())?;
    let bytes = match &part.inline_bytes {
        Some(bytes) => bytes.clone(),
        None => client
            .attachment(request.message_id, &part.attachment_id)
            .await
            .map_err(|error| error.to_string())?,
    };
    let cache = cache.clone();
    let account_id = request.account_id.to_owned();
    let message_id = request.message_id.to_owned();
    let attachment_id = request.record.attachment_id.clone();
    let filename = request.record.filename.clone();
    let mime_type = request.record.mime_type.clone();
    tokio::task::spawn_blocking(move || {
        cache.write_bytes(
            AttachmentDescriptor {
                target: AttachmentRef {
                    account_id: &account_id,
                    message_id: &message_id,
                    attachment_id: &attachment_id,
                },
                filename: &filename,
                mime_type: &mime_type,
            },
            &bytes,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

pub fn decode_text(bytes: &[u8]) -> String {
    let (decoded, _, had_errors) = encoding_rs::UTF_8.decode(bytes);
    if !had_errors {
        return decoded.into_owned();
    }
    let (windows_1252, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
    windows_1252.into_owned()
}
