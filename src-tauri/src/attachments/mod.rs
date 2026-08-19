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

pub fn decode_text(bytes: &[u8]) -> String {
    let (decoded, _, had_errors) = encoding_rs::UTF_8.decode(bytes);
    if !had_errors {
        return decoded.into_owned();
    }
    let (windows_1252, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
    windows_1252.into_owned()
}
