pub mod commands;

use std::collections::HashMap;

use ammonia::clean_text;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Local};

use crate::storage::{Attachment, InlinePart, Message};

const MIN_COLLAPSED_LINES: usize = 8;
const MIN_ENCODED_LINE_LENGTH: usize = 40;
const BYTES_PER_KILOBYTE: usize = 1024;
const BYTES_PER_MEGABYTE: usize = 1024 * 1024;
const EXPORT_CSP: &str =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";
const HEADER_TABLE_STYLE: &str = "border-collapse:collapse;margin:0 0 16px;font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2430";
const HEADER_LABEL_STYLE: &str =
    "text-align:left;vertical-align:top;padding:2px 16px 2px 0;color:#6b7385;font-weight:normal";
const NOTICE_STYLE: &str = "margin:0 0 16px;padding:8px 12px;border-radius:6px;background:#eef0f5;color:#414755;font:13px system-ui,-apple-system,'Segoe UI',sans-serif";
const REMOTE_IMAGES_NOTICE: &str = "Remote images were not included in this file.";

pub struct RecipientRoles<'a> {
    pub to: &'a str,
    pub cc: &'a str,
}

pub fn authentication_results(raw: &str) -> Option<String> {
    header_block(raw).into_iter().find_map(|header| {
        let (name, value) = header.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("Authentication-Results")
            .then(|| value.trim().to_owned())
    })
}

fn header_block(raw: &str) -> Vec<String> {
    let mut headers: Vec<String> = Vec::new();
    for line in raw.lines().take_while(|line| !line.is_empty()) {
        match headers.last_mut() {
            Some(last) if line.starts_with([' ', '\t']) => {
                last.push(' ');
                last.push_str(line.trim());
            }
            _ => headers.push(line.to_owned()),
        }
    }
    headers
}

pub fn collapse_encoded_bodies(raw: &str) -> String {
    let mut output = String::with_capacity(raw.len().min(BYTES_PER_MEGABYTE));
    let mut run: Vec<&str> = Vec::new();
    let mut part_name: Option<String> = None;
    for line in raw.split_inclusive('\n') {
        let content = line.trim_end_matches(['\r', '\n']);
        if is_encoded_line(content) {
            run.push(line);
            continue;
        }
        flush_run(&mut output, &mut run, part_name.as_deref());
        if content.starts_with("--") {
            part_name = None;
        } else if let Some(name) = declared_name(content) {
            part_name = Some(name);
        }
        output.push_str(line);
    }
    flush_run(&mut output, &mut run, part_name.as_deref());
    output
}

fn is_encoded_line(line: &str) -> bool {
    line.len() >= MIN_ENCODED_LINE_LENGTH
        && line
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

fn flush_run(output: &mut String, run: &mut Vec<&str>, name: Option<&str>) {
    if run.len() < MIN_COLLAPSED_LINES {
        run.drain(..).for_each(|line| output.push_str(line));
        return;
    }
    let encoded: usize = run.iter().map(|line| line.trim_end().len()).sum();
    output.push_str(&format!(
        "[{} · {} of base64 hidden · Copy and Download include it]\n",
        name.unwrap_or("Encoded part"),
        decoded_size(encoded)
    ));
    run.clear();
}

fn declared_name(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let start = lower.find("name=")? + "name=".len();
    let value = line[start..].trim().trim_start_matches('"');
    let end = value.find(['"', ';']).unwrap_or(value.len());
    Some(value[..end].trim().to_owned()).filter(|name| !name.is_empty())
}

fn decoded_size(encoded: usize) -> String {
    let bytes = encoded / 4 * 3;
    if bytes >= BYTES_PER_MEGABYTE {
        format!("{:.1} MB", bytes as f64 / BYTES_PER_MEGABYTE as f64)
    } else {
        format!("{} KB", (bytes / BYTES_PER_KILOBYTE).max(1))
    }
}

pub fn export_document(
    message: &Message,
    roles: &RecipientRoles<'_>,
    attachments: &[Attachment],
    inline_parts: &[InlinePart],
) -> Option<String> {
    let (body, remote_images_blocked) = match (&message.html_body, &message.plain_body) {
        (Some(html), _) => {
            let sanitized = crate::sanitize::sanitize_for_export(html, &inline_sources(inline_parts));
            (sanitized.html, sanitized.remote_images_blocked)
        }
        (None, Some(plain)) => (
            format!(
                "<pre style=\"white-space:pre-wrap;font:14px/1.5 ui-monospace,Consolas,monospace\">{}</pre>",
                clean_text(plain)
            ),
            false,
        ),
        (None, None) => return None,
    };
    let to = if roles.to.is_empty() {
        message.recipients.as_str()
    } else {
        roles.to
    };
    let date = DateTime::from_timestamp(message.sent_at, 0)
        .map(|sent| {
            sent.with_timezone(&Local)
                .format("%a, %-d %b %Y %H:%M")
                .to_string()
        })
        .unwrap_or_default();
    let attachment_names = attachments
        .iter()
        .map(|attachment| attachment.filename.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let rows = [
        ("From", message.sender.as_str()),
        ("To", to),
        ("Cc", roles.cc),
        ("Date", date.as_str()),
        ("Subject", message.subject.as_str()),
        ("Attachments", attachment_names.as_str()),
    ]
    .into_iter()
    .filter(|(_, value)| !value.is_empty())
    .map(|(label, value)| {
        format!(
            "<tr><th style=\"{HEADER_LABEL_STYLE}\">{label}</th><td>{}</td></tr>",
            clean_text(value)
        )
    })
    .collect::<String>();
    let notice = if remote_images_blocked {
        format!("<p style=\"{NOTICE_STYLE}\">{REMOTE_IMAGES_NOTICE}</p>")
    } else {
        String::new()
    };
    Some(format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{EXPORT_CSP}\"><title>{}</title></head><body><table style=\"{HEADER_TABLE_STYLE}\">{rows}</table>{notice}<div>{body}</div></body></html>\n",
        clean_text(&message.subject)
    ))
}

fn inline_sources(inline_parts: &[InlinePart]) -> HashMap<String, String> {
    inline_parts
        .iter()
        .filter(|part| part.mime_type.to_ascii_lowercase().starts_with("image/"))
        .map(|part| {
            (
                part.content_id.clone(),
                format!(
                    "data:{};base64,{}",
                    part.mime_type,
                    STANDARD.encode(&part.bytes)
                ),
            )
        })
        .collect()
}
