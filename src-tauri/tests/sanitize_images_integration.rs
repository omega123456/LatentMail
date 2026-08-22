use std::collections::HashMap;

use latentmail_lib::remote_images::proxy_url;
use latentmail_lib::sanitize::{referenced_content_ids, sanitize, MAX_SANITIZED_HTML_BYTES};

#[test]
fn resolves_cid_images_and_rewrites_remote_images() {
    let mut parts = HashMap::new();
    parts.insert("logo".into(), "inlineimg://localhost/?cid=logo".to_owned());
    let result = sanitize(
        r#"<img src="cid:logo"><img src="https://tracker.example/pixel.png"><img src="data:text/html,boom">"#,
        &parts,
        false,
    );
    assert!(
        result.html.contains("inlineimg://localhost/?cid=logo"),
        "{}",
        result.html
    );
    assert!(result.html.contains("data:image/gif;base64"));
    assert!(!result.html.contains("tracker.example"));
    assert!(!result.html.contains("data:text"));

    assert!(result.remote_images_blocked);
}

#[test]
fn passes_through_an_already_inlined_data_image_uri_unchanged() {
    let result = sanitize(
        r#"<img src="data:image/png;base64,AQID">"#,
        &HashMap::new(),
        false,
    );
    assert!(result.html.contains("data:image/png;base64,AQID"));
    assert!(!result.remote_images_blocked, "nothing was rewritten");
}

#[test]
fn resolves_angle_bracketed_content_ids() {
    let parts = HashMap::from([(
        "<logo>".into(),
        "inlineimg://localhost/?cid=logo".to_owned(),
    )]);

    let result = sanitize(r#"<img src="cid:logo">"#, &parts, false);

    assert!(result.html.contains("inlineimg://localhost/?cid=logo"));
}

#[test]
fn caps_html_at_an_element_boundary() {
    let source = format!(
        "<p>{}</p><p>after</p>",
        "a".repeat(MAX_SANITIZED_HTML_BYTES)
    );
    let result = sanitize(&source, &HashMap::new(), false);
    assert!(result.truncated);
    assert!(result.html.len() <= MAX_SANITIZED_HTML_BYTES);
    assert!(result.html.ends_with('>'));
    assert!(!result.html.contains("after"));
}

#[test]
fn allowing_remote_images_routes_them_through_the_proxy_and_reports_nothing_blocked() {
    let result = sanitize(
        r#"<img src="https://tracker.example/pixel.png"><img src="data:text/html,boom">"#,
        &HashMap::new(),
        true,
    );

    assert!(
        result
            .html
            .contains(&proxy_url("https://tracker.example/pixel.png")),
        "{}",
        result.html
    );
    assert!(!result.html.contains("data:image/gif;base64"));
    assert!(!result.html.contains("data:text"));
    assert!(!result.remote_images_blocked);
}

#[test]
fn blocks_remote_images_referenced_from_a_style_attribute() {
    let result = sanitize(
        r#"<div style="background:url('https://tracker.example/hand.gif') center/contain no-repeat,url(https://tracker.example/poster.png);width:146px"></div>"#,
        &HashMap::new(),
        false,
    );

    assert!(!result.html.contains("tracker.example"), "{}", result.html);
    assert!(result.html.contains("width:146px"), "{}", result.html);
    assert!(result.html.contains("data:image/gif;base64"));
    assert!(result.remote_images_blocked);
}

#[test]
fn routes_style_attribute_images_through_the_proxy_when_remote_images_are_allowed() {
    let result = sanitize(
        r#"<div style="background:url('https://tracker.example/hand.gif') center/contain"></div>"#,
        &HashMap::new(),
        true,
    );

    assert!(
        result
            .html
            .contains(&proxy_url("https://tracker.example/hand.gif")),
        "{}",
        result.html
    );
    assert!(result.html.contains("center/contain"), "{}", result.html);
    assert!(!result.remote_images_blocked);
}

#[test]
fn resolves_content_id_images_referenced_from_a_style_attribute() {
    let parts = HashMap::from([(
        "logo".to_owned(),
        "inlineimg://localhost/?cid=logo".to_owned(),
    )]);

    let result = sanitize(
        r#"<div style="background-image:url(cid:logo)"></div>"#,
        &parts,
        false,
    );

    assert!(result.html.contains("inlineimg://localhost/?cid=logo"));
    assert!(!result.remote_images_blocked);
}

#[test]
fn substitutes_the_placeholder_for_a_style_image_that_resolves_to_nothing() {
    let result = sanitize(
        r#"<div style="background:url(cid:missing)"></div><span style="background:url(data:text/html,boom)"></span>"#,
        &HashMap::new(),
        true,
    );

    assert!(!result.html.contains("boom"), "{}", result.html);
    assert!(!result.html.contains("cid:"), "{}", result.html);
    assert_eq!(result.html.matches("data:image/gif;base64").count(), 2);
}

#[test]
fn leaves_a_style_attribute_without_images_untouched() {
    let result = sanitize(r#"<div style="color:red"></div>"#, &HashMap::new(), false);

    assert!(result.html.contains("color:red"));
    assert!(!result.remote_images_blocked);
}

#[test]
fn reports_an_unresolved_cid_image_and_substitutes_the_placeholder() {
    let result = sanitize(r#"<img src="cid:logo@example.com">"#, &HashMap::new(), true);

    assert!(result.inline_images_missing);
    assert!(!result.html.contains("cid:"), "{}", result.html);
    assert!(
        result.html.contains("data:image/gif;base64"),
        "{}",
        result.html
    );
    assert!(!result.remote_images_blocked);
}

#[test]
fn treats_a_content_id_that_resolves_to_an_empty_source_as_unresolved() {
    let parts = HashMap::from([("logo".into(), String::new())]);

    let result = sanitize(r#"<img src="cid:logo">"#, &parts, false);

    assert!(result.inline_images_missing);
    assert!(
        result.html.contains("data:image/gif;base64"),
        "{}",
        result.html
    );
}

#[test]
fn a_resolved_cid_image_is_not_reported_as_missing() {
    let parts = HashMap::from([("logo".into(), "inlineimg://localhost/?cid=logo".to_owned())]);

    let result = sanitize(r#"<img src="cid:logo">"#, &parts, false);

    assert!(!result.inline_images_missing);
}

#[test]
fn reads_every_content_id_an_html_body_references() {
    let ids = referenced_content_ids(
        r#"<img src="cid:one@host"><img src='CID:<two@host>'><div style="background:url(cid:three@host)"></div>no cid: here"#,
    );

    assert_eq!(ids, vec!["one@host", "two@host", "three@host"]);
}

#[test]
fn reads_no_content_ids_from_a_body_without_any() {
    assert!(referenced_content_ids("<p>plain</p>").is_empty());
}
