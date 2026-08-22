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
