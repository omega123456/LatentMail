use std::time::Duration;

use tauri::http::{Response, StatusCode};
use url::{form_urlencoded, Url};

pub const SCHEME: &str = "remoteimg";
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
const RETRY_DELAY: Duration = Duration::from_millis(250);

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
        Ok((content_type, bytes)) => builder
            .status(StatusCode::OK)
            .header("content-type", content_type)
            .header("cache-control", "max-age=86400")
            .body(bytes),
        Err(reason) => {
            tracing::debug!("remote image refused ({reason}): {uri}");
            builder.status(StatusCode::NOT_FOUND).body(Vec::new())
        }
    }
    .expect("remote image response builds")
}

async fn fetch(client: &reqwest::Client, uri: &str) -> Result<(String, Vec<u8>), String> {
    let target = target(uri).ok_or_else(|| "not an http target".to_owned())?;
    match send(client, target.clone()).await {
        Ok(response) => read(response).await,
        Err(error) if error.is_connect() && !error.is_timeout() => {
            tokio::time::sleep(RETRY_DELAY).await;
            let retried = send(client, target).await.map_err(|last| last.to_string())?;
            read(retried).await
        }
        Err(error) => Err(error.to_string()),
    }
}

async fn send(client: &reqwest::Client, target: Url) -> Result<reqwest::Response, reqwest::Error> {
    client.get(target).timeout(TIMEOUT).send().await
}

async fn read(response: reqwest::Response) -> Result<(String, Vec<u8>), String> {
    if !response.status().is_success() {
        return Err(format!("status {}", response.status()));
    }
    if response.content_length().is_some_and(|length| length > MAX_BYTES) {
        return Err("declared size over the ceiling".to_owned());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "no content type".to_owned())?
        .to_owned();
    if !content_type.starts_with("image/") {
        return Err(format!("content type {content_type}"));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("body over the ceiling".to_owned());
    }
    Ok((content_type, bytes.to_vec()))
}
