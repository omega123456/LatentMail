use lettre::{
    address::Envelope,
    message::{
        header::{InReplyTo, References},
        Attachment, Mailbox, MultiPart,
    },
    Message,
};
use thiserror::Error;

pub const MAX_RFC2822_BYTES: usize = 25_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Part {
    pub filename: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
    pub content_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingMessage {
    pub from: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub html: String,
    pub quote_html: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub inline: Vec<Part>,
    pub attachments: Vec<Part>,
}

#[derive(Debug, Error)]
pub enum MimeError {
    #[error("invalid mailbox: {0}")]
    Address(#[from] lettre::address::AddressError),
    #[error("invalid message: {0}")]
    Build(#[from] lettre::error::Error),
    #[error("unable to derive plain text: {0}")]
    Plain(#[from] html2text::Error),
    #[error("assembled message exceeds Gmail's 25,000,000 byte limit ({actual} bytes)")]
    TooLarge { actual: usize },
}

pub fn assemble(outgoing: &OutgoingMessage) -> Result<Vec<u8>, MimeError> {
    let html = format!(
        "{}{}",
        outgoing.html,
        outgoing.quote_html.as_deref().unwrap_or_default()
    );
    let plain = html2text::from_read(html.as_bytes(), 80)?;
    let alternative = MultiPart::alternative_plain_html(plain, html.clone());
    let related = outgoing.inline.iter().fold(
        MultiPart::related().multipart(alternative),
        |multipart, part| {
            let attachment = Attachment::new_inline_with_name(
                part.content_id
                    .clone()
                    .unwrap_or_else(|| part.filename.clone()),
                part.filename.clone(),
            )
            .body(
                part.bytes.clone(),
                part.mime_type.parse().expect("valid staged MIME type"),
            );
            multipart.singlepart(attachment)
        },
    );
    let body = if outgoing.inline.is_empty() {
        MultiPart::alternative_plain_html(html2text::from_read(html.as_bytes(), 80)?, html)
    } else {
        related
    };
    let multipart =
        outgoing
            .attachments
            .iter()
            .fold(MultiPart::mixed().multipart(body), |multipart, part| {
                multipart.singlepart(Attachment::new(part.filename.clone()).body(
                    part.bytes.clone(),
                    part.mime_type.parse().expect("valid staged MIME type"),
                ))
            });
    let from = outgoing.from.parse::<Mailbox>()?;
    let mut builder = Message::builder()
        .keep_bcc()
        .envelope(Envelope::new(
            Some(from.email.clone()),
            vec![from.email.clone()],
        )?)
        .from(from)
        .subject(&outgoing.subject);
    for recipient in &outgoing.to {
        builder = builder.to(recipient.parse::<Mailbox>()?);
    }
    for recipient in &outgoing.cc {
        builder = builder.cc(recipient.parse::<Mailbox>()?);
    }
    for recipient in &outgoing.bcc {
        builder = builder.bcc(recipient.parse::<Mailbox>()?);
    }
    if let Some(value) = &outgoing.in_reply_to {
        builder = builder.header(InReplyTo::from(value.clone()));
    }
    if !outgoing.references.is_empty() {
        builder = builder.header(References::from(outgoing.references.join(" ")));
    }
    let bytes = builder.multipart(multipart)?.formatted();
    validate_encoded_size(bytes.len())?;
    Ok(bytes)
}

pub fn validate_encoded_size(actual: usize) -> Result<(), MimeError> {
    if actual > MAX_RFC2822_BYTES {
        Err(MimeError::TooLarge { actual })
    } else {
        Ok(())
    }
}
