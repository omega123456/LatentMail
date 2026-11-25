use std::net::{IpAddr, SocketAddr};

use latentmail_lib::remote_images::{
    follows_redirect, is_public_address, proxy_url, respond, retain_public_addresses, target,
    HostScope, MAX_REDIRECTS, SCHEME,
};
use tauri::http::Response;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn respond_including_private(client: &reqwest::Client, uri: &str) -> Response<Vec<u8>> {
    respond(client, uri, HostScope::IncludingPrivate).await
}

#[test]
fn builds_a_proxy_url_that_carries_the_original_target() {
    let url = proxy_url("https://tracker.example/pixel.png?a=1&b=2");

    assert!(url.contains(SCHEME), "{url}");
    assert_eq!(
        target(&url).map(|value| value.to_string()),
        Some("https://tracker.example/pixel.png?a=1&b=2".to_owned())
    );
}

#[test]
fn refuses_targets_that_are_not_http_urls() {
    assert!(target(&proxy_url("file:///etc/passwd")).is_none());
    assert!(target(&proxy_url("data:image/gif;base64,AQID")).is_none());
    assert!(target("remoteimg://localhost/?other=1").is_none());
    assert!(target("not a url").is_none());
}

#[tokio::test]
async fn serves_a_remote_image_from_the_application_origin() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hand.gif"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(vec![1, 2, 3], "image/gif")
                .insert_header("cross-origin-resource-policy", "same-origin"),
        )
        .mount(&server)
        .await;

    let response = respond_including_private(
        &latentmail_lib::http_client(),
        &proxy_url(&format!("{}/hand.gif", server.uri())),
    )
    .await;

    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        &"image/gif"
    );
    assert_eq!(response.body(), &vec![1, 2, 3]);
}

#[tokio::test]
async fn refuses_responses_that_are_not_images() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/page.html"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(b"<html>".to_vec(), "text/html"))
        .mount(&server)
        .await;

    let response = respond_including_private(
        &latentmail_lib::http_client(),
        &proxy_url(&format!("{}/page.html", server.uri())),
    )
    .await;

    assert_eq!(response.status(), 404);
    assert!(response.body().is_empty());
}

#[tokio::test]
async fn reports_missing_images_as_not_found() {
    let server = MockServer::start().await;

    let response = respond_including_private(
        &latentmail_lib::http_client(),
        &proxy_url(&format!("{}/gone.png", server.uri())),
    )
    .await;

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn refuses_a_response_that_declares_no_content_type() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/nothing"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let response = respond_including_private(
        &latentmail_lib::http_client(),
        &proxy_url(&format!("{}/nothing", server.uri())),
    )
    .await;

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn refuses_a_body_that_ends_before_its_declared_length() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/truncated.png"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(vec![1, 2, 3], "image/png")
                .insert_header("content-length", "4096"),
        )
        .mount(&server)
        .await;

    let response = respond_including_private(
        &latentmail_lib::http_client(),
        &proxy_url(&format!("{}/truncated.png", server.uri())),
    )
    .await;

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn refuses_a_target_that_redirects_forever() {
    let server = MockServer::start().await;
    let destination = format!("{}/loop.png", server.uri());
    Mock::given(method("GET"))
        .and(path("/loop.png"))
        .respond_with(ResponseTemplate::new(302).insert_header("location", destination.as_str()))
        .mount(&server)
        .await;

    let response =
        respond_including_private(&latentmail_lib::http_client(), &proxy_url(&destination)).await;

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn retries_once_when_the_connection_fails_and_then_reports_not_found() {
    let response = respond_including_private(
        &latentmail_lib::http_client(),
        &proxy_url("http://127.0.0.1:1/a.png"),
    )
    .await;

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn refuses_images_that_exceed_the_size_ceiling() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/huge.png"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(vec![0; 16], "image/png")
                .insert_header("content-length", "9999999999"),
        )
        .mount(&server)
        .await;

    let response = respond_including_private(
        &latentmail_lib::http_client(),
        &proxy_url(&format!("{}/huge.png", server.uri())),
    )
    .await;

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn respond_refuses_a_target_that_is_not_http() {
    let response = respond_including_private(
        &latentmail_lib::http_client(),
        &format!("{SCHEME}://proxy/?url=ftp%3A%2F%2Fexample.com%2Fa.png"),
    )
    .await;

    assert_eq!(response.status(), 404);
    assert!(response.body().is_empty());
}

#[tokio::test]
async fn sniffs_images_that_arrive_as_a_generic_binary_stream() {
    let png = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/icons/tray-icon.png"))
        .expect("tray icon reads");
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/qrcode.png"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(png.clone(), "application/octet-stream"),
        )
        .mount(&server)
        .await;

    let response = respond_including_private(
        &latentmail_lib::http_client(),
        &proxy_url(&format!("{}/qrcode.png", server.uri())),
    )
    .await;

    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        &"image/png"
    );
    assert_eq!(response.body(), &png);
}

#[tokio::test]
async fn refuses_loopback_private_and_link_local_targets_without_contacting_them() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(vec![1, 2, 3], "image/gif"))
        .expect(0)
        .mount(&server)
        .await;
    let port = server.address().port();
    let private_targets = [
        format!("http://127.0.0.1:{port}/a.gif"),
        format!("http://localhost:{port}/a.gif"),
        format!("http://app.localhost:{port}/a.gif"),
        format!("http://[::1]:{port}/a.gif"),
        format!("http://[::ffff:127.0.0.1]:{port}/a.gif"),
        "http://10.0.0.8/a.gif".to_owned(),
        "http://192.168.1.1/a.gif".to_owned(),
        "http://172.16.0.1/a.gif".to_owned(),
        "http://169.254.169.254/latest/meta-data".to_owned(),
        "http://0.0.0.0/a.gif".to_owned(),
        "http://[fd00::1]/a.gif".to_owned(),
        "http://[fe80::1]/a.gif".to_owned(),
        "http://100.64.0.1/a.gif".to_owned(),
        "http://0.1.2.3/a.gif".to_owned(),
        "http://192.0.0.9/a.gif".to_owned(),
        "http://198.18.0.1/a.gif".to_owned(),
        "http://192.0.2.1/a.gif".to_owned(),
        "http://224.0.0.1/a.gif".to_owned(),
        "http://240.0.0.1/a.gif".to_owned(),
        "http://[::7f00:1]/a.gif".to_owned(),
        "http://[64:ff9b::7f00:1]/a.gif".to_owned(),
        "http://[2002:7f00:1::]/a.gif".to_owned(),
        "http://[2002:c0a8:101::]/a.gif".to_owned(),
        "http://[ff02::1]/a.gif".to_owned(),
    ];
    for private_target in private_targets {
        let response = respond(
            &latentmail_lib::http_client(),
            &proxy_url(&private_target),
            HostScope::PublicOnly,
        )
        .await;
        assert_eq!(response.status(), 404, "{private_target}");
    }
    server.verify().await;
}

#[test]
fn public_hosts_pass_the_public_only_scope() {
    let public_target = target(&proxy_url("https://images.example.com/a.png")).unwrap();
    assert!(HostScope::PublicOnly.permits(&public_target));
    let public_address = target(&proxy_url("http://93.184.216.34/a.png")).unwrap();
    assert!(HostScope::PublicOnly.permits(&public_address));
    let loopback = target(&proxy_url("http://127.0.0.1/a.png")).unwrap();
    assert!(!HostScope::PublicOnly.permits(&loopback));
    assert!(HostScope::IncludingPrivate.permits(&loopback));
}

fn address(literal: &str) -> IpAddr {
    literal.parse().expect("test address literal")
}

#[test]
fn addresses_that_embed_or_neighbour_a_public_ipv4_stay_public() {
    let public_literals = [
        "93.184.216.34",
        "100.128.0.1",
        "198.20.0.1",
        "2606:4700::1111",
        "::ffff:93.184.216.34",
        "64:ff9b::5db8:d822",
        "2002:5db8:d822::",
    ];
    for literal in public_literals {
        assert!(is_public_address(address(literal)), "{literal}");
    }
}

#[test]
fn ipv4_embedded_in_ipv6_is_judged_by_the_embedded_address() {
    let private_literals = [
        "::",
        "::1",
        "::a00:1",
        "::ffff:10.0.0.1",
        "64:ff9b::a9fe:a9fe",
        "2002:a00:1::",
    ];
    for literal in private_literals {
        assert!(!is_public_address(address(literal)), "{literal}");
    }
}

#[test]
fn redirects_are_followed_only_to_public_http_hosts_within_the_limit() {
    let public = url::Url::parse("https://cdn.example.com/a.png").unwrap();
    assert!(follows_redirect(&public, 1));
    assert!(follows_redirect(&public, MAX_REDIRECTS));
    assert!(!follows_redirect(&public, MAX_REDIRECTS + 1));

    let refused_targets = [
        "http://127.0.0.1/a.png",
        "http://localhost/a.png",
        "http://192.168.1.1/a.png",
        "http://[::1]/a.png",
        "http://100.64.0.1/a.png",
        "file:///etc/passwd",
    ];
    for refused in refused_targets {
        let next = url::Url::parse(refused).unwrap();
        assert!(!follows_redirect(&next, 1), "{refused}");
    }
}

#[test]
fn resolved_addresses_keep_only_the_public_ones() {
    let resolved: Vec<SocketAddr> = ["127.0.0.1:443", "93.184.216.34:443", "[fd00::1]:443"]
        .iter()
        .map(|literal| literal.parse().unwrap())
        .collect();

    let public = retain_public_addresses(resolved).unwrap();

    assert_eq!(
        public,
        vec!["93.184.216.34:443".parse::<SocketAddr>().unwrap()]
    );
}

#[test]
fn a_name_that_resolves_only_to_private_addresses_is_refused() {
    let resolved: Vec<SocketAddr> = ["127.0.0.1:80", "[::1]:80", "10.0.0.1:80"]
        .iter()
        .map(|literal| literal.parse().unwrap())
        .collect();

    assert!(retain_public_addresses(resolved).is_err());
}

#[tokio::test]
async fn the_remote_image_client_does_not_follow_a_redirect_to_a_private_host() {
    let server = MockServer::start().await;
    let private_location = format!("http://127.0.0.1:{}/internal.gif", server.address().port());
    Mock::given(method("GET"))
        .and(path("/public.gif"))
        .respond_with(ResponseTemplate::new(302).insert_header("location", private_location))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/internal.gif"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(vec![1, 2, 3], "image/gif"))
        .expect(0)
        .mount(&server)
        .await;

    let response = respond_including_private(
        &latentmail_lib::remote_image_client(),
        &proxy_url(&format!("{}/public.gif", server.uri())),
    )
    .await;

    assert_eq!(response.status(), 404);
    server.verify().await;
}
