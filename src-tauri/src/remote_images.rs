use std::time::Duration;

use tauri::http::{Response, StatusCode};
use url::{form_urlencoded, Url};

pub const SCHEME: &str = "remoteimg";
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);

pub fn proxy_url(target: &str) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("url", target)
        .finish();
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost/?{query}")
    } else {
        format!("{SCHEME}://localhost/?{query}")
    }
}

pub fn target(uri: &str) -> Option<Url> {
    let requested = Url::parse(uri).ok()?;
    let target = requested
        .query_pairs()
        .find(|(key, _)| key == "url")
        .map(|(_, value)| value.into_owned())?;
    let target = Url::parse(&target).ok()?;
    matches!(target.scheme(), "http" | "https").then_some(target)
}

pub async fn respond(client: &reqwest::Client, uri: &str) -> Response<Vec<u8>> {
    let builder = Response::builder().header("access-control-allow-origin", "*");
    match fetch(client, uri).await {
        Some((content_type, bytes)) => builder
            .status(StatusCode::OK)
            .header("content-type", content_type)
            .header("cache-control", "max-age=86400")
            .body(bytes),
        None => {
            tracing::debug!("remote image refused: {uri}");
            builder.status(StatusCode::NOT_FOUND).body(Vec::new())
        }
    }
    .expect("remote image response builds")
}

async fn fetch(client: &reqwest::Client, uri: &str) -> Option<(String, Vec<u8>)> {
    let response = client.get(target(uri)?).timeout(TIMEOUT).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    if response.content_length().is_some_and(|length| length > MAX_BYTES) {
        return None;
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)?
        .to_str()
        .ok()?
        .to_owned();
    if !content_type.starts_with("image/") {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    (bytes.len() as u64 <= MAX_BYTES).then(|| (content_type, bytes.to_vec()))
}
