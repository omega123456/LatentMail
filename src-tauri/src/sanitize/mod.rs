use std::{borrow::Cow, collections::HashMap};

use ammonia::Builder;

pub const MAX_SANITIZED_HTML_BYTES: usize = 512 * 1024;
pub const CID_SCHEME: &str = "cid:";
const DATA_IMAGE_PREFIX: &str = "data:image/";
const DATA_SCHEME: &str = "data:";
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
    while let Some(offset) = lower[cursor..].find(CID_SCHEME) {
        let start = cursor + offset + CID_SCHEME.len();
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
    cap(clean(html, cid_sources, allow_remote))
}

pub fn sanitize_for_export(html: &str, cid_sources: &HashMap<String, String>) -> SanitizedHtml {
    clean(html, cid_sources, false)
}

const ALLOWED_GENERIC_ATTRIBUTES: &[&str] = &[
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
];

const ALLOWED_URL_SCHEMES: &[&str] = &[
    "http",
    "https",
    "mailto",
    "data",
    "cid",
    crate::remote_images::SCHEME,
];

struct AttributeInput<'element, 'attribute, 'value> {
    element: &'element str,
    attribute: &'attribute str,
    value: &'value str,
}

fn filter_attribute<'value>(
    input: AttributeInput<'_, '_, 'value>,
    context: &ImageFilterContext<'_>,
) -> Option<Cow<'value, str>> {
    match (input.element, input.attribute) {
        ("a", "href")
            if matches!(
                input
                    .value
                    .trim_start()
                    .to_ascii_lowercase()
                    .split_once(':'),
                Some(("data" | "cid", _))
            ) =>
        {
            None
        }
        ("img", "src") => image_source(input.value, context).map(Cow::Owned),
        (_, "style") => {
            Some(style_images(input.value, context).map_or(Cow::Borrowed(input.value), Cow::Owned))
        }
        _ => Some(Cow::Borrowed(input.value)),
    }
}

fn clean(html: &str, cid_sources: &HashMap<String, String>, allow_remote: bool) -> SanitizedHtml {
    let cid_sources = cid_sources.clone();
    let outcome = std::sync::Arc::new(ImageOutcome::default());
    let outcome_in_filter = std::sync::Arc::clone(&outcome);
    let mut builder = Builder::default();
    builder
        .add_tags(&["style", "font"])
        .rm_clean_content_tags(&["style"])
        .add_clean_content_tags(&["title"])
        .add_generic_attributes(ALLOWED_GENERIC_ATTRIBUTES)
        .url_schemes(ALLOWED_URL_SCHEMES.iter().copied().collect())
        .attribute_filter(move |element, attribute, value| {
            filter_attribute(
                AttributeInput {
                    element: element,
                    attribute: attribute,
                    value: value,
                },
                &ImageFilterContext {
                    cid_sources: &cid_sources,
                    outcome: &outcome_in_filter,
                    allow_remote: allow_remote,
                },
            )
        });
    let html = builder.clean(html).to_string();
    SanitizedHtml {
        html: html,
        truncated: false,
        remote_images_blocked: ImageOutcome::read(&outcome.remote_blocked),
        inline_images_missing: ImageOutcome::read(&outcome.inline_missing),
    }
}

struct ImageFilterContext<'a> {
    cid_sources: &'a HashMap<String, String>,
    outcome: &'a ImageOutcome,
    allow_remote: bool,
}

fn image_source(value: &str, context: &ImageFilterContext<'_>) -> Option<String> {
    let source = value.trim();
    let lower = source.to_ascii_lowercase();
    if let Some(cid) = lower.strip_prefix(CID_SCHEME) {
        let id = source[source.len() - cid.len()..].trim_matches(['<', '>']);
        let source = context
            .cid_sources
            .get(id)
            .or_else(|| context.cid_sources.get(&format!("<{id}>")))
            .filter(|source| !source.is_empty());
        let Some(source) = source else {
            ImageOutcome::mark(&context.outcome.inline_missing);
            return Some(REMOTE_IMAGE_PLACEHOLDER.to_owned());
        };
        return Some(source.clone());
    }
    if lower.starts_with(DATA_IMAGE_PREFIX) {
        return Some(source.to_owned());
    }
    if lower.starts_with(DATA_SCHEME) {
        return None;
    }
    if context.allow_remote {
        return Some(crate::remote_images::proxy_url(source));
    }
    ImageOutcome::mark(&context.outcome.remote_blocked);
    Some(REMOTE_IMAGE_PLACEHOLDER.to_owned())
}

fn style_images(value: &str, context: &ImageFilterContext<'_>) -> Option<String> {
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
            &image_source(target, context).unwrap_or_else(|| REMOTE_IMAGE_PLACEHOLDER.to_owned()),
        );
        rewritten.push('\'');
        cursor = close;
    }
    rewritten.push_str(&value[cursor..]);
    Some(rewritten)
}

fn cap(sanitized: SanitizedHtml) -> SanitizedHtml {
    if sanitized.html.len() <= MAX_SANITIZED_HTML_BYTES {
        return sanitized;
    }
    let limit = char_boundary_at_or_before(&sanitized.html, MAX_SANITIZED_HTML_BYTES);
    let boundary = sanitized.html[..limit]
        .rfind('>')
        .map_or(limit, |index| index + 1);
    SanitizedHtml {
        html: sanitized.html[..boundary].to_owned(),
        truncated: true,
        ..sanitized
    }
}

fn char_boundary_at_or_before(text: &str, index: usize) -> usize {
    (0..=index)
        .rev()
        .find(|candidate| text.is_char_boundary(*candidate))
        .unwrap_or(0)
}
