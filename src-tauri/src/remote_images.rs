use std::{
    net::{Ipv4Addr, Ipv6Addr},
    time::Duration,
};

use tauri::http::Response;
use url::{form_urlencoded, Host, Url};

use crate::image_scheme::{self, ServedImage};

pub const SCHEME: &str = "remoteimg";
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
const RETRY_DELAY: Duration = Duration::from_millis(250);
const LOCALHOST: &str = "localhost";
const LOCALHOST_SUFFIX: &str = ".localhost";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostScope {
    PublicOnly,
    IncludingPrivate,
}

impl HostScope {
    pub fn permits(self, target: &Url) -> bool {
        self == Self::IncludingPrivate || is_public_host(target)
    }
}

fn is_public_host(target: &Url) -> bool {
    match target.host() {
        Some(Host::Domain(domain)) => !is_localhost_name(domain),
        Some(Host::Ipv4(address)) => is_public_ipv4(address),
        Some(Host::Ipv6(address)) => is_public_ipv6(address),
        None => false,
    }
}

fn is_localhost_name(domain: &str) -> bool {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    domain == LOCALHOST || domain.ends_with(LOCALHOST_SUFFIX)
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let reserved = address.is_loopback()
        || address.is_private()
        || address.is_link_local()
        || address.is_unspecified()
        || address.is_broadcast();
    !reserved
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    let reserved = address.is_loopback()
        || address.is_unspecified()
        || address.is_unique_local()
        || address.is_unicast_link_local();
    !reserved
}

pub fn proxy_url(target: &str) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("url", target)
        .finish();
    image_scheme::proxy_url(SCHEME, &query)
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

pub async fn respond(client: &reqwest::Client, uri: &str, hosts: HostScope) -> Response<Vec<u8>> {
    image_scheme::respond(SCHEME, uri, fetch(client, uri, hosts).await)
}

async fn fetch(
    client: &reqwest::Client,
    uri: &str,
    hosts: HostScope,
) -> Result<ServedImage, String> {
    let target = target(uri).ok_or_else(|| "not an http target".to_owned())?;
    if !hosts.permits(&target) {
        return Err("a private or loopback host".to_owned());
    }
    match send(client, target.clone()).await {
        Ok(response) => read(response).await,
        Err(error) if error.is_connect() && !error.is_timeout() => {
            tokio::time::sleep(RETRY_DELAY).await;
            let retried = send(client, target)
                .await
                .map_err(|last| last.to_string())?;
            read(retried).await
        }
        Err(error) => Err(error.to_string()),
    }
}

async fn send(client: &reqwest::Client, target: Url) -> Result<reqwest::Response, reqwest::Error> {
    client.get(target).timeout(TIMEOUT).send().await
}

async fn read(response: reqwest::Response) -> Result<ServedImage, String> {
    if !response.status().is_success() {
        return Err(format!("status {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BYTES)
    {
        return Err("declared size over the ceiling".to_owned());
    }
    let declared = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("body over the ceiling".to_owned());
    }
    let content_type = declared
        .filter(|value| value.starts_with("image/"))
        .or_else(|| {
            image::guess_format(&bytes)
                .ok()
                .map(|format| format.to_mime_type().to_owned())
        })
        .ok_or_else(|| "not an image".to_owned())?;
    Ok(ServedImage {
        content_type: content_type,
        bytes: bytes.to_vec(),
    })
}
