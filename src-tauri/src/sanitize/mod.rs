use std::{borrow::Cow, collections::HashMap};

use ammonia::Builder;
use base64::{engine::general_purpose::STANDARD, Engine};

pub const MAX_SANITIZED_HTML_BYTES: usize = 512 * 1024;
const REMOTE_IMAGE_PLACEHOLDER: &str =
    "data:image/gif;base64,R0lGODlhAQABAIAAAMLCwgAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CidPart {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SanitizedHtml {
    pub html: String,
    pub truncated: bool,
    pub remote_images_blocked: bool,
}

pub fn sanitize(
    html: &str,
    cid_parts: &HashMap<String, CidPart>,
    allow_remote: bool,
) -> SanitizedHtml {
    let cid_parts = cid_parts.clone();
    let blocked = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let blocked_in_filter = std::sync::Arc::clone(&blocked);
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
        .url_schemes(["http", "https", "mailto", "data", "cid"].into())
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
                ("img", "src") => image_source(value, &cid_parts, &blocked_in_filter, allow_remote)
                    .map(Cow::Owned),
                _ => Some(Cow::Borrowed(value)),
            },
        );
    let mut sanitized = cap(builder.clean(html).to_string());
    sanitized.remote_images_blocked = blocked.load(std::sync::atomic::Ordering::Relaxed);
    sanitized
}

fn image_source(
    value: &str,
    cid_parts: &HashMap<String, CidPart>,
    blocked: &std::sync::atomic::AtomicBool,
    allow_remote: bool,
) -> Option<String> {
    let source = value.trim();
    let lower = source.to_ascii_lowercase();
    if let Some(cid) = lower.strip_prefix("cid:") {
        let id = source[source.len() - cid.len()..].trim_matches(['<', '>']);
        return cid_parts
            .get(id)
            .or_else(|| cid_parts.get(&format!("<{id}>")))
            .map(|part| {
                format!(
                    "data:{};base64,{}",
                    part.mime_type,
                    STANDARD.encode(&part.bytes)
                )
            });
    }
    if lower.starts_with("data:image/") {
        return Some(source.to_owned());
    }
    if lower.starts_with("data:") {
        return None;
    }
    if allow_remote {
        return Some(source.to_owned());
    }
    blocked.store(true, std::sync::atomic::Ordering::Relaxed);
    Some(REMOTE_IMAGE_PLACEHOLDER.to_owned())
}

fn cap(html: String) -> SanitizedHtml {
    if html.len() <= MAX_SANITIZED_HTML_BYTES {
        return SanitizedHtml {
            html,
            truncated: false,
            remote_images_blocked: false,
        };
    }
    let boundary = html[..MAX_SANITIZED_HTML_BYTES]
        .rfind('>')
        .map_or(MAX_SANITIZED_HTML_BYTES, |index| index + 1);
    SanitizedHtml {
        html: html[..boundary].to_owned(),
        truncated: true,
        remote_images_blocked: false,
    }
}
