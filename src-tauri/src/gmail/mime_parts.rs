use mime::Mime;

use super::mapping::{bytes_to_text, decode, headers};
use super::wire::RawPart;
use super::{AttachmentPart, InlinePart, PLAIN_TEXT_WRAP_COLUMNS, RESERVED_ATTACHMENT_ID_PREFIX};

#[derive(Default)]
pub(super) struct Content {
    pub(super) html: Option<String>,
    pub(super) plain: Option<String>,
    pub(super) candidates: Vec<AttachmentCandidate>,
    pub(super) inline: Vec<InlinePart>,
}

#[derive(Clone)]
pub(super) struct AttachmentCandidate {
    pub(super) attachment_id: Option<String>,
    pub(super) content_id: Option<String>,
    pub(super) filename: Option<String>,
    pub(super) mime_type: String,
    pub(super) size: u64,
    pub(super) bytes: Option<Vec<u8>>,
}

pub(super) fn collect_part(part: &RawPart, content: &mut Content) {
    let mime = parse_part_mime(part);
    let data = decode_part_data(part);
    let cid = extract_content_id(part);
    let filename = extract_filename(part);
    let is_attachment = filename.is_some();

    if filename.is_some() || cid.is_some() {
        content.candidates.push(build_attachment_candidate(
            part,
            CandidateMeta {
                mime: &mime,
                content_id: cid.clone(),
                filename: filename,
                data: data.clone(),
            },
        ));
    }
    if let (Some(content_id), Some(bytes)) = (cid, data.clone()) {
        content.inline.push(InlinePart {
            content_id: content_id,
            mime_type: mime.essence_str().to_owned(),
            bytes: bytes,
        });
    }
    if !is_attachment {
        record_text_body(content, &mime, data);
    }
    if mime.type_() == mime::MESSAGE {
        append_embedded_message(part, &mime, content);
        return;
    }
    if let Some(parts) = &part.parts {
        for child in parts {
            collect_part(child, content);
        }
    }
}

struct CandidateMeta<'a> {
    mime: &'a Mime,
    content_id: Option<String>,
    filename: Option<String>,
    data: Option<Vec<u8>>,
}

fn parse_part_mime(part: &RawPart) -> Mime {
    part.mime_type
        .as_deref()
        .and_then(|value| value.parse::<Mime>().ok())
        .unwrap_or(mime::APPLICATION_OCTET_STREAM)
}

fn decode_part_data(part: &RawPart) -> Option<Vec<u8>> {
    part.body
        .as_ref()
        .and_then(|body| body.data.as_deref())
        .and_then(decode)
}

fn extract_content_id(part: &RawPart) -> Option<String> {
    part.headers.as_deref().and_then(|headers| {
        headers
            .iter()
            .find(|header| header.name.eq_ignore_ascii_case("content-id"))
            .map(|header| header.value.trim().trim_matches(['<', '>']).to_owned())
    })
}

fn extract_filename(part: &RawPart) -> Option<String> {
    part.filename
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn build_attachment_candidate(part: &RawPart, meta: CandidateMeta<'_>) -> AttachmentCandidate {
    let attachment_id = part
        .body
        .as_ref()
        .and_then(|body| body.attachment_id.as_deref())
        .map(str::to_owned);
    let size = part
        .body
        .as_ref()
        .and_then(|body| body.size)
        .unwrap_or_else(|| meta.data.as_ref().map_or(0, |bytes| bytes.len() as u64));
    AttachmentCandidate {
        attachment_id: attachment_id,
        content_id: meta.content_id,
        filename: meta.filename,
        mime_type: meta.mime.essence_str().to_owned(),
        size: size,
        bytes: meta.data,
    }
}

fn record_text_body(content: &mut Content, mime: &Mime, data: Option<Vec<u8>>) {
    let slot = match (mime.type_(), mime.subtype()) {
        (mime::TEXT, mime::HTML) => Some(&mut content.html),
        (mime::TEXT, mime::PLAIN) => Some(&mut content.plain),
        _ => None,
    };
    if let (Some(slot), Some(bytes)) = (slot, data) {
        if slot.is_none() {
            *slot = Some(bytes_to_text(bytes));
        }
    }
}

fn append_embedded_message(part: &RawPart, mime: &Mime, content: &mut Content) {
    if mime.subtype() != "rfc822" {
        return;
    }
    let Some(block) = embedded_message(part) else {
        return;
    };
    match &mut content.plain {
        Some(plain) => plain.push_str(&block),
        slot => *slot = Some(block.trim_start().to_owned()),
    }
}

fn embedded_message(part: &RawPart) -> Option<String> {
    let root = part.parts.as_deref()?.first()?;
    let mut carried = Content::default();
    collect_part(root, &mut carried);
    let carried_headers = headers(root.headers.as_deref().unwrap_or_default());
    let mut block = String::from("\n\n---------- Forwarded message ----------\n");
    for name in ["From", "To", "Cc", "Bcc", "Date", "Subject"] {
        if let Some(value) = carried_headers.get(&name.to_ascii_lowercase()) {
            block.push_str(&format!("{name}: {value}\n"));
        }
    }
    let body = carried.plain.or_else(|| {
        carried
            .html
            .and_then(|html| html2text::from_read(html.as_bytes(), PLAIN_TEXT_WRAP_COLUMNS).ok())
    });
    block.push('\n');
    block.push_str(body.unwrap_or_default().trim_end());
    Some(block)
}

pub(super) fn classify_attachments(
    candidates: Vec<AttachmentCandidate>,
    html: Option<&str>,
) -> Vec<AttachmentPart> {
    let mut result = Vec::with_capacity(candidates.len());
    for (position, candidate) in candidates.into_iter().enumerate() {
        let locally_held = candidate.bytes.is_some();
        let cid_referenced = is_inline_cid_referenced(candidate.content_id.as_deref(), html);
        if cid_referenced && locally_held {
            continue;
        }
        let attachment_id = candidate
            .attachment_id
            .clone()
            .unwrap_or_else(|| synthesize_attachment_id(candidate.content_id.as_deref(), position));
        let filename = candidate
            .filename
            .clone()
            .unwrap_or_else(|| format!("attachment-{position}"));
        result.push(AttachmentPart {
            attachment_id: attachment_id,
            content_id: candidate.content_id,
            filename: filename,
            mime_type: candidate.mime_type,
            size: candidate.size,
            inline_bytes: candidate.bytes,
        });
    }
    result
}

fn is_inline_cid_referenced(content_id: Option<&str>, html: Option<&str>) -> bool {
    let (Some(content_id), Some(html)) = (content_id, html) else {
        return false;
    };
    html.contains(&format!("{}{content_id}", crate::sanitize::CID_SCHEME))
}

fn synthesize_attachment_id(content_id: Option<&str>, position: usize) -> String {
    match content_id {
        Some(content_id) => format!(
            "{RESERVED_ATTACHMENT_ID_PREFIX}cid-{}",
            sanitize_path_segment(content_id)
        ),
        None => format!("{RESERVED_ATTACHMENT_ID_PREFIX}pos-{position}"),
    }
}

fn sanitize_path_segment(value: &str) -> String {
    let sanitized: String = value.chars().map(sanitize_path_char).collect();
    if sanitized.is_empty() {
        return "empty".to_owned();
    }
    sanitized
}

fn sanitize_path_char(character: char) -> char {
    let is_safe = character.is_ascii_alphanumeric() || character == '-' || character == '_';
    if is_safe {
        return character;
    }
    '_'
}
