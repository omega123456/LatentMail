use reqwest::StatusCode;

pub fn http_client() -> reqwest::Client {
    static SHARED_CLIENT: std::sync::LazyLock<reqwest::Client> =
        std::sync::LazyLock::new(build_http_client);
    SHARED_CLIENT.clone()
}

fn build_http_client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let builder = reqwest::Client::builder();
    #[cfg(feature = "test-utils")]
    let builder = builder.no_proxy();
    builder.build().expect("http client")
}

pub fn is_retryable_status(status: u16) -> bool {
    let Ok(code) = StatusCode::from_u16(status) else {
        return false;
    };
    let is_rate_limited = code == StatusCode::TOO_MANY_REQUESTS;
    is_rate_limited || code.is_server_error()
}
