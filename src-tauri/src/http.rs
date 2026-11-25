use std::sync::{Arc, LazyLock};

use reqwest::StatusCode;

use crate::remote_images;

pub fn http_client() -> reqwest::Client {
    static SHARED_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(build_http_client);
    SHARED_CLIENT.clone()
}

pub fn remote_image_client() -> reqwest::Client {
    static REMOTE_IMAGE_CLIENT: LazyLock<reqwest::Client> =
        LazyLock::new(build_remote_image_client);
    REMOTE_IMAGE_CLIENT.clone()
}

fn client_builder() -> reqwest::ClientBuilder {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let builder = reqwest::Client::builder();
    #[cfg(feature = "test-utils")]
    let builder = builder.no_proxy();
    builder
}

fn build_http_client() -> reqwest::Client {
    client_builder().build().expect("http client")
}

fn build_remote_image_client() -> reqwest::Client {
    client_builder()
        .redirect(remote_images::redirect_policy())
        .dns_resolver(Arc::new(remote_images::PublicAddressResolver))
        .build()
        .expect("remote image client")
}

pub fn is_retryable_status(status: u16) -> bool {
    let Ok(code) = StatusCode::from_u16(status) else {
        return false;
    };
    let is_rate_limited = code == StatusCode::TOO_MANY_REQUESTS;
    is_rate_limited || code.is_server_error()
}
