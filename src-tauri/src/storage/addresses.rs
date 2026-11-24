#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddressIdentity {
    pub display: String,
    pub address: String,
}

pub fn split_addresses(header: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in header.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                current.push(ch);
            }
            ',' if !in_quotes => {
                push_trimmed(&mut result, &current);
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    push_trimmed(&mut result, &current);
    result
}

fn push_trimmed(result: &mut Vec<String>, entry: &str) {
    let trimmed = entry.trim();
    if !trimmed.is_empty() {
        result.push(trimmed.to_owned());
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mailbox {
    pub name: Option<String>,
    pub address: String,
}

pub fn parse_mailbox(entry: &str) -> Option<Mailbox> {
    let entry = entry.trim();
    if entry.is_empty() {
        return None;
    }
    let Some(start) = entry.find('<') else {
        return Some(Mailbox {
            name: None,
            address: entry.to_owned(),
        });
    };
    let end = entry[start..].find('>').map(|offset| start + offset)?;
    let address = entry[start + 1..end].trim();
    if address.is_empty() {
        return None;
    }
    let name = unquote(entry[..start].trim());
    Some(Mailbox {
        name: (!name.is_empty()).then_some(name),
        address: address.to_owned(),
    })
}

pub fn parse_address(entry: &str) -> Option<AddressIdentity> {
    let mailbox = parse_mailbox(entry)?;
    let display = mailbox.name.unwrap_or_else(|| mailbox.address.clone());
    Some(AddressIdentity {
        display: display,
        address: mailbox.address,
    })
}

fn unquote(value: &str) -> String {
    let is_quoted = value.len() >= 2 && value.starts_with('"') && value.ends_with('"');
    if is_quoted {
        return value[1..value.len() - 1].to_owned();
    }
    value.to_owned()
}

pub fn first_identity(header: &str) -> Option<AddressIdentity> {
    split_addresses(header)
        .into_iter()
        .find_map(|entry| parse_address(&entry))
}

pub fn domain_of(address: &str) -> Option<String> {
    if !address.contains('@') {
        return None;
    }
    let domain = address.rsplit('@').next()?;
    let domain = domain.trim().to_ascii_lowercase();
    if domain.is_empty() {
        return None;
    }
    Some(domain)
}
