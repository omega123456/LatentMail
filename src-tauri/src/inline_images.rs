use tauri::http::Response;
use url::{form_urlencoded, Url};

use crate::image_scheme::{self, ServedImage};
use crate::storage::{MessageKey, MessageRepository, Storage};

pub const SCHEME: &str = "inlineimg";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineImageTarget {
    pub account_id: String,
    pub message_id: String,
    pub content_id: String,
}

pub fn proxy_url(account_id: &str, message_id: &str, content_id: &str) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("account", account_id)
        .append_pair("message", message_id)
        .append_pair("cid", content_id)
        .finish();
    image_scheme::proxy_url(SCHEME, &query)
}

pub fn target(uri: &str) -> Option<InlineImageTarget> {
    let requested = Url::parse(uri).ok()?;
    let mut account = None;
    let mut message = None;
    let mut content = None;
    for (key, value) in requested.query_pairs() {
        match key.as_ref() {
            "account" => account = Some(value.into_owned()),
            "message" => message = Some(value.into_owned()),
            "cid" => content = Some(value.into_owned()),
            _ => {}
        }
    }
    Some(InlineImageTarget {
        account_id: account?,
        message_id: message?,
        content_id: content?,
    })
}

pub async fn respond(storage: &Storage, uri: &str) -> Response<Vec<u8>> {
    image_scheme::respond(SCHEME, uri, read(storage, uri).await)
}

async fn read(storage: &Storage, uri: &str) -> Result<ServedImage, String> {
    let parsed = target(uri).ok_or_else(|| "incomplete request".to_owned())?;
    storage
        .run(move |connection| {
            MessageRepository::inline_part(
                connection,
                MessageKey {
                    account_id: &parsed.account_id,
                    message_id: &parsed.message_id,
                },
                &parsed.content_id,
            )
        })
        .await
        .map_err(|error| error.to_string())?
        .map(|part| ServedImage {
            content_type: part.mime_type,
            bytes: part.bytes,
        })
        .ok_or_else(|| "no such inline part".to_owned())
}
