use std::{borrow::Cow, collections::HashMap};

use ammonia::Builder;
use base64::{engine::general_purpose::STANDARD, Engine};

pub const MAX_SANITIZED_HTML_BYTES: usize = 512 * 1024;
const REMOTE_IMAGE_PLACEHOLDER: &str =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CidPart {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SanitizedHtml {
    pub html: String,
    pub truncated: bool,
}

pub fn sanitize(html: &str, cid_parts: &HashMap<String, CidPart>) -> SanitizedHtml {
    let cid_parts = cid_parts.clone();
    let mut builder = Builder::default();
    builder
        .add_tags(&["style"])
        .rm_clean_content_tags(&["style"])
        .add_generic_attributes(&["style"])
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
                ("img", "src") => image_source(value, &cid_parts).map(Cow::Owned),
                _ => Some(Cow::Borrowed(value)),
            },
        );
    cap(builder.clean(html).to_string())
}

fn image_source(value: &str, cid_parts: &HashMap<String, CidPart>) -> Option<String> {
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
    Some(REMOTE_IMAGE_PLACEHOLDER.to_owned())
}

fn cap(html: String) -> SanitizedHtml {
    if html.len() <= MAX_SANITIZED_HTML_BYTES {
        return SanitizedHtml {
            html,
            truncated: false,
        };
    }
    let boundary = html[..MAX_SANITIZED_HTML_BYTES]
        .rfind('>')
        .map_or(MAX_SANITIZED_HTML_BYTES, |index| index + 1);
    SanitizedHtml {
        html: html[..boundary].to_owned(),
        truncated: true,
    }
}
