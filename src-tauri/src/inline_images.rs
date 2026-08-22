use tauri::http::{Response, StatusCode};
use url::{form_urlencoded, Url};

use crate::storage::{MessageRepository, Storage};

pub const SCHEME: &str = "inlineimg";

pub fn proxy_url(account_id: &str, message_id: &str, content_id: &str) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("account", account_id)
        .append_pair("message", message_id)
        .append_pair("cid", content_id)
        .finish();
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost/?{query}")
    } else {
        format!("{SCHEME}://localhost/?{query}")
    }
}

pub fn target(uri: &str) -> Option<(String, String, String)> {
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
    Some((account?, message?, content?))
}

pub async fn respond(storage: &Storage, uri: &str) -> Response<Vec<u8>> {
    let builder = Response::builder().header("access-control-allow-origin", "*");
    match read(storage, uri).await {
        Ok((mime_type, bytes)) => builder
            .status(StatusCode::OK)
            .header("content-type", mime_type)
            .header("cache-control", "max-age=86400")
            .body(bytes),
        Err(reason) => {
            tracing::debug!("inline image refused ({reason}): {uri}");
            builder.status(StatusCode::NOT_FOUND).body(Vec::new())
        }
    }
    .expect("inline image response builds")
}

async fn read(storage: &Storage, uri: &str) -> Result<(String, Vec<u8>), String> {
    let (account_id, message_id, content_id) =
        target(uri).ok_or_else(|| "incomplete request".to_owned())?;
    storage
        .run(move |connection| {
            MessageRepository::inline_part(connection, &account_id, &message_id, &content_id)
        })
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no such inline part".to_owned())
}
