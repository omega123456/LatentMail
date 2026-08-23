pub mod cache;
pub mod commands;
pub mod thumbnail;

pub use cache::{AttachmentCache, CachedAttachment, CACHE_CEILING_BYTES};

use crate::gmail::AttachmentPart;

pub fn seed_cache(
    cache: &AttachmentCache,
    account_id: &str,
    message_id: &str,
    parts: &[AttachmentPart],
) {
    for part in parts {
        if let Some(bytes) = &part.inline_bytes {
            let _ = cache.write_bytes(
                account_id,
                message_id,
                &part.attachment_id,
                &part.filename,
                &part.mime_type,
                bytes,
            );
        }
    }
}

pub async fn refetch(
    cache: &AttachmentCache,
    client: &crate::gmail::GmailClient,
    account_id: &str,
    message_id: &str,
    record: &crate::storage::Attachment,
) -> Result<CachedAttachment, String> {
    let refreshed = client
        .message(message_id)
        .await
        .map_err(|error| error.to_string())?;
    let part = refreshed
        .attachment_parts
        .iter()
        .find(|part| part.filename == record.filename)
        .ok_or_else(|| "Attachment is no longer part of this message".to_owned())?;
    let bytes = match &part.inline_bytes {
        Some(bytes) => bytes.clone(),
        None => client
            .attachment(message_id, &part.attachment_id)
            .await
            .map_err(|error| error.to_string())?,
    };
    let cache = cache.clone();
    let account_id = account_id.to_owned();
    let message_id = message_id.to_owned();
    let attachment_id = record.attachment_id.clone();
    let filename = record.filename.clone();
    let mime_type = record.mime_type.clone();
    tokio::task::spawn_blocking(move || {
        cache.write_bytes(
            &account_id,
            &message_id,
            &attachment_id,
            &filename,
            &mime_type,
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
