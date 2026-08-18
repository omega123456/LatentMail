use std::collections::HashMap;

use latentmail_lib::sanitize::sanitize;

#[test]
fn strips_executable_markup_and_unsafe_urls() {
    let result = sanitize(
        r#"<script>alert(1)</script><p onclick="alert(1)">safe</p><a href="javascript:alert(1)">bad</a><a href="data:text/html,boom">also bad</a><iframe>no</iframe><object>no</object><embed><form>no</form>"#,
        &HashMap::new(),
        false,
    );
    for forbidden in [
        "script",
        "onclick",
        "javascript:",
        "data:text",
        "iframe",
        "object",
        "embed",
        "form",
    ] {
        assert!(
            !result.html.contains(forbidden),
            "{forbidden} survived: {}",
            result.html
        );
    }
    assert!(result.html.contains("safe"));
}

#[test]
fn preserves_email_layout_markup() {
    let result = sanitize(
        r#"<style>.notice { color: red; }</style><table style="width:100%"><thead><tr><th>Heading</th></tr></thead><tbody><tr><td style="font-weight:bold">Body</td></tr></tbody></table>"#,
        &HashMap::new(),
        false,
    );
    for expected in [
        "<style>",
        "color: red",
        "<table",
        "<thead>",
        "<tbody>",
        "<td",
        "style=",
        "font-weight:bold",
    ] {
        assert!(
            result.html.contains(expected),
            "{expected} missing: {}",
            result.html
        );
    }
}

#[test]
fn preserves_inert_class_and_id_attributes() {
    let result = sanitize(
        r#"<p id="mail-body" class="newsletter hero">Body</p>"#,
        &HashMap::new(),
        false,
    );
    assert!(result.html.contains("id=\"mail-body\""));
    assert!(result.html.contains("class=\"newsletter hero\""));
}
