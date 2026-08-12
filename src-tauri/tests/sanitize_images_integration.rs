use std::collections::HashMap;

use latentmail_lib::sanitize::{sanitize, CidPart, MAX_SANITIZED_HTML_BYTES};

#[test]
fn resolves_cid_images_and_rewrites_remote_images() {
    let mut parts = HashMap::new();
    parts.insert(
        "logo".into(),
        CidPart {
            bytes: vec![1, 2, 3],
            mime_type: "image/png".into(),
        },
    );
    let result = sanitize(
        r#"<img src="cid:logo"><img src="https://tracker.example/pixel.png"><img src="data:text/html,boom">"#,
        &parts,
    );
    assert!(
        result.html.contains("data:image/png;base64,AQID"),
        "{}",
        result.html
    );
    assert!(result.html.contains("data:image/gif;base64"));
    assert!(!result.html.contains("tracker.example"));
    assert!(!result.html.contains("data:text"));
    // The reader renders its "Remote images are blocked" notice off this
    // flag; without it a real message shows placeholder gifs unexplained.
    assert!(result.remote_images_blocked);
}

#[test]
fn passes_through_an_already_inlined_data_image_uri_unchanged() {
    let result = sanitize(r#"<img src="data:image/png;base64,AQID">"#, &HashMap::new());
    assert!(result.html.contains("data:image/png;base64,AQID"));
    assert!(!result.remote_images_blocked, "nothing was rewritten");
}

#[test]
fn caps_html_at_an_element_boundary() {
    let source = format!(
        "<p>{}</p><p>after</p>",
        "a".repeat(MAX_SANITIZED_HTML_BYTES)
    );
    let result = sanitize(&source, &HashMap::new());
    assert!(result.truncated);
    assert!(result.html.len() <= MAX_SANITIZED_HTML_BYTES);
    assert!(result.html.ends_with('>'));
    assert!(!result.html.contains("after"));
}
