use url::Url;

use crate::storage::addresses::split_addresses;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mailto {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
}

pub fn parse(value: &str) -> Option<Mailto> {
    if !valid_percent_encoding(value) {
        return None;
    }
    let url = Url::parse(value).ok()?;
    let is_invalid_mailto =
        url.scheme() != "mailto" || url.host().is_some() || url.port().is_some();
    if is_invalid_mailto {
        return None;
    }
    let recipients = |value: &str| {
        let decoded =
            url::form_urlencoded::parse(format!("to={}", value.replace('+', "%2B")).as_bytes())
                .next()
                .map(|(_, value)| value.into_owned())
                .unwrap_or_default();
        split_addresses(&decoded)
    };
    let mut mailto = Mailto {
        to: recipients(url.path()),
        cc: Vec::new(),
        bcc: Vec::new(),
        subject: String::new(),
        body: String::new(),
    };
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "to" => mailto.to.extend(recipients(&value)),
            "cc" => mailto.cc.extend(recipients(&value)),
            "bcc" => mailto.bcc.extend(recipients(&value)),
            "subject" => mailto.subject = value.into_owned(),
            "body" => mailto.body = value.into_owned(),
            _ => {}
        }
    }
    Some(mailto)
}

fn is_percent_escape(bytes: &[u8], index: usize) -> bool {
    index + 2 < bytes.len()
        && bytes[index + 1].is_ascii_hexdigit()
        && bytes[index + 2].is_ascii_hexdigit()
}

fn valid_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            index += 1;
            continue;
        }
        if !is_percent_escape(bytes, index) {
            return false;
        }
        index += 3;
    }
    true
}
