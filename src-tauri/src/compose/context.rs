use crate::{sanitize, storage::Message};
use std::collections::HashMap;

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
        .map(|html| sanitize::sanitize(html, &HashMap::new()).html)
        .or_else(|| {
            message
                .plain_body
                .as_ref()
                .map(|text| format!("<p>{}</p>", html_escape(text)))
        });
    html.map(|html| DisplayQuote {
        html,
        attribution: format!(
            "On {}, {} wrote:",
            chrono::DateTime::from_timestamp(message.sent_at, 0)
                .map(|value| value.format("%b %-d, %Y at %H:%M").to_string())
                .unwrap_or_default(),
            message.sender
        ),
    })
}
fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\n', "<br>")
}

fn addresses(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
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
    if subject
        .trim_start()
        .to_ascii_lowercase()
        .starts_with(&format!("{}:", prefix.to_ascii_lowercase()))
    {
        subject.to_owned()
    } else {
        format!("{prefix}: {subject}")
    }
}

pub fn reply(
    message: &Message,
    to: &str,
    cc: &str,
    account_email: &str,
    all: bool,
    references: Option<&str>,
) -> ReplyContext {
    let from_self = address_key(&message.sender) == account_email.to_ascii_lowercase();
    let mut recipients = if from_self {
        addresses(to)
    } else {
        addresses(&message.sender)
    };
    if all {
        recipients.extend(addresses(to));
    }
    let cc = if all { addresses(cc) } else { Vec::new() };
    let mut chain = references.map(addresses).unwrap_or_default();
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
    }
}

pub fn forward(message: &Message) -> ReplyContext {
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
    }
}
