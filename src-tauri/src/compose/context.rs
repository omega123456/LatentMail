use crate::{
    sanitize,
    storage::{addresses::split_addresses, Message},
};
use std::collections::HashMap;

const ATTRIBUTION_DATE_FORMAT: &str = "%b %-d, %Y at %H:%M";

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyContext {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub original_message_id: String,
    pub target_thread_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub original_gmail_message_id: String,
    pub display_quote: Option<DisplayQuote>,
    pub attachments: Vec<ReplyAttachment>,
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyAttachment {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayQuote {
    pub html: String,
    pub attribution: String,
}

pub fn display_quote(message: &Message) -> Option<DisplayQuote> {
    let html = message
        .html_body
        .as_deref()
        .map(|html| sanitize::sanitize(html, &HashMap::new(), false).html)
        .or_else(|| {
            message
                .plain_body
                .as_ref()
                .map(|text| format!("<p>{}</p>", plain_text_html(text)))
        });
    html.map(|html| DisplayQuote {
        html: html,
        attribution: attribution(message),
    })
}

pub fn outgoing_quote(message: &Message) -> String {
    let body = message
        .html_body
        .clone()
        .or_else(|| {
            message
                .plain_body
                .as_deref()
                .map(|plain| format!("<pre>{}</pre>", escape_html(plain)))
        })
        .unwrap_or_default();
    format!(
        "<p>{}</p><blockquote>{body}</blockquote>",
        escape_html(&attribution(message))
    )
}

fn attribution(message: &Message) -> String {
    let sent_at = chrono::DateTime::from_timestamp(message.sent_at, 0)
        .map(|value| value.format(ATTRIBUTION_DATE_FORMAT).to_string())
        .unwrap_or_default();
    format!("On {sent_at}, {} wrote:", message.sender)
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn plain_text_html(value: &str) -> String {
    escape_html(value).replace('\n', "<br>")
}

fn address_key(value: &str) -> String {
    value
        .rsplit_once('<')
        .and_then(|(_, address)| address.strip_suffix('>'))
        .unwrap_or(value)
        .trim()
        .to_ascii_lowercase()
}
fn without_account(values: Vec<String>, account_email: &str) -> Vec<String> {
    let account = account_email.to_ascii_lowercase();
    values
        .into_iter()
        .filter(|value| address_key(value) != account)
        .fold(Vec::new(), |mut values, value| {
            if !values
                .iter()
                .any(|existing| address_key(existing) == address_key(&value))
            {
                values.push(value);
            }
            values
        })
}
fn prefixed(subject: &str, prefix: &str) -> String {
    let expected_prefix = format!("{}:", prefix.to_ascii_lowercase());
    let already_prefixed = subject
        .trim_start()
        .to_ascii_lowercase()
        .starts_with(&expected_prefix);
    if already_prefixed {
        return subject.to_owned();
    }
    format!("{prefix}: {subject}")
}

fn initial_reply_recipients(from_self: bool, to: &str, sender: &str) -> Vec<String> {
    if from_self {
        return split_addresses(to);
    }
    split_addresses(sender)
}

fn reply_cc_recipients(all: bool, cc: &str) -> Vec<String> {
    if all {
        return split_addresses(cc);
    }
    Vec::new()
}

pub fn reply(
    message: &Message,
    to: &str,
    cc: &str,
    account_email: &str,
    all: bool,
    references: Option<&str>,
    attachments: Vec<ReplyAttachment>,
) -> ReplyContext {
    let from_self = address_key(&message.sender) == account_email.to_ascii_lowercase();
    let mut recipients = initial_reply_recipients(from_self, to, &message.sender);
    if all {
        recipients.extend(split_addresses(to));
    }
    let cc = reply_cc_recipients(all, cc);
    let mut chain = references.map(split_addresses).unwrap_or_default();
    if let Some(id) = &message.rfc_message_id {
        chain.push(id.clone());
    }
    ReplyContext {
        to: without_account(recipients, account_email),
        cc: without_account(cc, account_email),
        subject: prefixed(&message.subject, "Re"),
        original_message_id: message.id.clone(),
        target_thread_id: Some(message.thread_id.clone()),
        in_reply_to: message.rfc_message_id.clone(),
        references: chain,
        original_gmail_message_id: message.id.clone(),
        display_quote: display_quote(message),
        attachments: attachments,
    }
}

pub fn forward(message: &Message, attachments: Vec<ReplyAttachment>) -> ReplyContext {
    ReplyContext {
        to: Vec::new(),
        cc: Vec::new(),
        subject: prefixed(&message.subject, "Fwd"),
        original_message_id: message.id.clone(),
        target_thread_id: None,
        in_reply_to: None,
        references: Vec::new(),
        original_gmail_message_id: message.id.clone(),
        display_quote: display_quote(message),
        attachments: attachments,
    }
}
