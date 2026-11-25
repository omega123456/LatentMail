use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};

use ipnet::{Ipv4Net, Ipv6Net};
use reqwest::{
    dns::{Addrs, Name, Resolve, Resolving},
    redirect,
};
use tauri::http::Response;
use url::{form_urlencoded, Host, Url};

use crate::image_scheme::{self, ServedImage};

pub const SCHEME: &str = "remoteimg";
pub const MAX_REDIRECTS: usize = 10;
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
const RETRY_DELAY: Duration = Duration::from_millis(250);
const LOCALHOST: &str = "localhost";
const LOCALHOST_SUFFIX: &str = ".localhost";
const IPV4_OCTET_COUNT: usize = 4;

const THIS_NETWORK: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::new(0, 0, 0, 0), 8);
const SHARED_ADDRESS_SPACE: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::new(100, 64, 0, 0), 10);
const PROTOCOL_ASSIGNMENTS: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::new(192, 0, 0, 0), 24);
const BENCHMARKING: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::new(198, 18, 0, 0), 15);
const MULTICAST_AND_RESERVED: Ipv4Net = Ipv4Net::new_assert(Ipv4Addr::new(224, 0, 0, 0), 3);

const NON_PUBLIC_IPV4_NETWORKS: [Ipv4Net; 5] = [
    THIS_NETWORK,
    SHARED_ADDRESS_SPACE,
    PROTOCOL_ASSIGNMENTS,
    BENCHMARKING,
    MULTICAST_AND_RESERVED,
];

struct Ipv4Embedding {
    network: Ipv6Net,
    first_octet: usize,
}

const IPV4_COMPATIBLE: Ipv4Embedding = Ipv4Embedding {
    network: Ipv6Net::new_assert(Ipv6Addr::UNSPECIFIED, 96),
    first_octet: 12,
};
const NAT64: Ipv4Embedding = Ipv4Embedding {
    network: Ipv6Net::new_assert(Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, 0, 0), 96),
    first_octet: 12,
};
const SIX_TO_FOUR: Ipv4Embedding = Ipv4Embedding {
    network: Ipv6Net::new_assert(Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16),
    first_octet: 2,
};

const IPV4_EMBEDDINGS: [Ipv4Embedding; 3] = [IPV4_COMPATIBLE, NAT64, SIX_TO_FOUR];

impl Ipv4Embedding {
    fn extract(&self, address: Ipv6Addr) -> Option<Ipv4Addr> {
        let octets = address.octets();
        let embedded = octets.get(self.first_octet..self.first_octet + IPV4_OCTET_COUNT)?;
        <[u8; IPV4_OCTET_COUNT]>::try_from(embedded)
            .ok()
            .map(Ipv4Addr::from)
    }
}

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

pub fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_special_purpose_ipv4(address: Ipv4Addr) -> bool {
    address.is_loopback()
        || address.is_private()
        || address.is_link_local()
        || address.is_unspecified()
        || address.is_broadcast()
        || address.is_documentation()
}

fn is_in_non_public_ipv4_network(address: Ipv4Addr) -> bool {
    NON_PUBLIC_IPV4_NETWORKS
        .iter()
        .any(|network| network.contains(&address))
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let reserved = is_special_purpose_ipv4(address) || is_in_non_public_ipv4_network(address);
    !reserved
}

fn embedded_ipv4(address: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return Some(mapped);
    }
    IPV4_EMBEDDINGS
        .iter()
        .find(|embedding| embedding.network.contains(&address))
        .and_then(|embedding| embedding.extract(address))
}

fn is_special_purpose_ipv6(address: Ipv6Addr) -> bool {
    address.is_loopback()
        || address.is_unspecified()
        || address.is_unique_local()
        || address.is_unicast_link_local()
        || address.is_multicast()
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(embedded) = embedded_ipv4(address) {
        return is_public_ipv4(embedded);
    }
    !is_special_purpose_ipv6(address)
}

fn is_http_url(target: &Url) -> bool {
    matches!(target.scheme(), "http" | "https")
}

pub fn follows_redirect(next: &Url, visited: usize) -> bool {
    let within_limit = visited <= MAX_REDIRECTS;
    within_limit && is_http_url(next) && is_public_host(next)
}

pub fn redirect_policy() -> redirect::Policy {
    redirect::Policy::custom(|attempt| {
        if follows_redirect(attempt.url(), attempt.previous().len()) {
            return attempt.follow();
        }
        attempt.stop()
    })
}

#[derive(Debug, thiserror::Error)]
#[error("every resolved address is private or loopback")]
pub struct NoPublicAddress;

pub fn retain_public_addresses(
    addresses: impl IntoIterator<Item = SocketAddr>,
) -> Result<Vec<SocketAddr>, NoPublicAddress> {
    let public: Vec<SocketAddr> = addresses
        .into_iter()
        .filter(|address| is_public_address(address.ip()))
        .collect();
    if public.is_empty() {
        return Err(NoPublicAddress);
    }
    Ok(public)
}

pub struct PublicAddressResolver;

impl Resolve for PublicAddressResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let resolved = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let public = retain_public_addresses(resolved)?;
            let addresses: Addrs = Box::new(public.into_iter());
            Ok(addresses)
        })
    }
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
    is_http_url(&target).then_some(target)
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
