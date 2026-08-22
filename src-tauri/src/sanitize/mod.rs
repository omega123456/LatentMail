use std::{borrow::Cow, collections::HashMap};

use ammonia::Builder;

pub const MAX_SANITIZED_HTML_BYTES: usize = 512 * 1024;
const REMOTE_IMAGE_PLACEHOLDER: &str =
    "data:image/gif;base64,R0lGODlhAQABAIAAAMLCwgAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SanitizedHtml {
    pub html: String,
    pub truncated: bool,
    pub remote_images_blocked: bool,
    pub inline_images_missing: bool,
}

#[derive(Default)]
struct ImageOutcome {
    remote_blocked: std::sync::atomic::AtomicBool,
    inline_missing: std::sync::atomic::AtomicBool,
}

impl ImageOutcome {
    fn mark(flag: &std::sync::atomic::AtomicBool) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    fn read(flag: &std::sync::atomic::AtomicBool) -> bool {
        flag.load(std::sync::atomic::Ordering::Relaxed)
    }
}

pub fn referenced_content_ids(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut ids = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = lower[cursor..].find("cid:") {
        let start = cursor + offset + "cid:".len();
        let end = html[start..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '"' | '\'' | ')' | '>')
            })
            .map_or(html.len(), |index| start + index);
        let id = html[start..end].trim_matches(['<', '>']);
        if !id.is_empty() {
            ids.push(id.to_owned());
        }
        cursor = end.max(start + 1).min(html.len());
    }
    ids
}

pub fn sanitize(
    html: &str,
    cid_sources: &HashMap<String, String>,
    allow_remote: bool,
) -> SanitizedHtml {
    let cid_sources = cid_sources.clone();
    let outcome = std::sync::Arc::new(ImageOutcome::default());
    let outcome_in_filter = std::sync::Arc::clone(&outcome);
    let mut builder = Builder::default();
    builder
        .add_tags(&["style", "font"])
        .rm_clean_content_tags(&["style"])
        .add_clean_content_tags(&["title"])
        .add_generic_attributes(&[
            "style",
            "class",
            "id",
            "align",
            "valign",
            "width",
            "height",
            "bgcolor",
            "border",
            "cellpadding",
            "cellspacing",
            "color",
            "face",
            "size",
            "dir",
            "nowrap",
            "role",
        ])
        .url_schemes(
            [
                "http",
                "https",
                "mailto",
                "data",
                "cid",
                crate::remote_images::SCHEME,
            ]
            .into(),
        )
        .attribute_filter(
            move |element, attribute, value| match (element, attribute) {
                ("a", "href")
                    if matches!(
                        value.trim_start().to_ascii_lowercase().split_once(':'),
                        Some(("data" | "cid", _))
                    ) =>
                {
                    None
                }
                ("img", "src") => {
                    image_source(value, &cid_sources, &outcome_in_filter, allow_remote)
                        .map(Cow::Owned)
                }
                (_, "style") => Some(
                    style_images(value, &cid_sources, &outcome_in_filter, allow_remote)
                        .map_or(Cow::Borrowed(value), Cow::Owned),
                ),
                _ => Some(Cow::Borrowed(value)),
            },
        );
    let mut sanitized = cap(builder.clean(html).to_string());
    sanitized.remote_images_blocked = ImageOutcome::read(&outcome.remote_blocked);
    sanitized.inline_images_missing = ImageOutcome::read(&outcome.inline_missing);
    sanitized
}

fn image_source(
    value: &str,
    cid_sources: &HashMap<String, String>,
    outcome: &ImageOutcome,
    allow_remote: bool,
) -> Option<String> {
    let source = value.trim();
    let lower = source.to_ascii_lowercase();
    if let Some(cid) = lower.strip_prefix("cid:") {
        let id = source[source.len() - cid.len()..].trim_matches(['<', '>']);
        let source = cid_sources
            .get(id)
            .or_else(|| cid_sources.get(&format!("<{id}>")))
            .filter(|source| !source.is_empty());
        let Some(source) = source else {
            ImageOutcome::mark(&outcome.inline_missing);
            return Some(REMOTE_IMAGE_PLACEHOLDER.to_owned());
        };
        return Some(source.clone());
    }
    if lower.starts_with("data:image/") {
        return Some(source.to_owned());
    }
    if lower.starts_with("data:") {
        return None;
    }
    if allow_remote {
        return Some(crate::remote_images::proxy_url(source));
    }
    ImageOutcome::mark(&outcome.remote_blocked);
    Some(REMOTE_IMAGE_PLACEHOLDER.to_owned())
}

fn style_images(
    value: &str,
    cid_sources: &HashMap<String, String>,
    outcome: &ImageOutcome,
    allow_remote: bool,
) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    if !lower.contains("url(") {
        return None;
    }
    let mut rewritten = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(offset) = lower[cursor..].find("url(") {
        let open = cursor + offset + "url(".len();
        let Some(length) = lower[open..].find(')') else {
            break;
        };
        let close = open + length;
        let target = value[open..close].trim().trim_matches(['"', '\'']);
        rewritten.push_str(&value[cursor..open]);
        rewritten.push('\'');
        rewritten.push_str(
            &image_source(target, cid_sources, outcome, allow_remote)
                .unwrap_or_else(|| REMOTE_IMAGE_PLACEHOLDER.to_owned()),
        );
        rewritten.push('\'');
        cursor = close;
    }
    rewritten.push_str(&value[cursor..]);
    Some(rewritten)
}

fn cap(html: String) -> SanitizedHtml {
    if html.len() <= MAX_SANITIZED_HTML_BYTES {
        return SanitizedHtml {
            html,
            truncated: false,
            remote_images_blocked: false,
            inline_images_missing: false,
        };
    }
    let boundary = html[..MAX_SANITIZED_HTML_BYTES]
        .rfind('>')
        .map_or(MAX_SANITIZED_HTML_BYTES, |index| index + 1);
    SanitizedHtml {
        html: html[..boundary].to_owned(),
        truncated: true,
        remote_images_blocked: false,
        inline_images_missing: false,
    }
}
