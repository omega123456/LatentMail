use latentmail_lib::remote_images::{proxy_url, respond, target, SCHEME};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

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

    let response = respond(
        &reqwest::Client::new(),
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

    let response = respond(
        &reqwest::Client::new(),
        &proxy_url(&format!("{}/page.html", server.uri())),
    )
    .await;

    assert_eq!(response.status(), 404);
    assert!(response.body().is_empty());
}

#[tokio::test]
async fn reports_missing_images_as_not_found() {
    let server = MockServer::start().await;

    let response = respond(
        &reqwest::Client::new(),
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

    let response = respond(
        &reqwest::Client::new(),
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

    let response = respond(
        &reqwest::Client::new(),
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

    let response = respond(&reqwest::Client::new(), &proxy_url(&destination)).await;

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn retries_once_when_the_connection_fails_and_then_reports_not_found() {
    let response = respond(
        &reqwest::Client::new(),
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

    let response = respond(
        &reqwest::Client::new(),
        &proxy_url(&format!("{}/huge.png", server.uri())),
    )
    .await;

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn respond_refuses_a_target_that_is_not_http() {
    let response = respond(
        &reqwest::Client::new(),
        &format!("{SCHEME}://proxy/?url=ftp%3A%2F%2Fexample.com%2Fa.png"),
    )
    .await;

    assert_eq!(response.status(), 404);
    assert!(response.body().is_empty());
}

#[tokio::test]
async fn sniffs_images_that_arrive_as_a_generic_binary_stream() {
    let png = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/icons/tray-icon.png"
    ))
    .expect("tray icon reads");
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/qrcode.png"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(png.clone(), "application/octet-stream"),
        )
        .mount(&server)
        .await;

    let response = respond(
        &reqwest::Client::new(),
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
