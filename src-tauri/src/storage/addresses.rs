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

pub fn parse_address(entry: &str) -> Option<AddressIdentity> {
    let entry = entry.trim();
    if entry.is_empty() {
        return None;
    }
    if let Some(start) = entry.find('<') {
        let end = entry[start..].find('>').map(|offset| start + offset)?;
        let address = entry[start + 1..end].trim();
        if address.is_empty() {
            return None;
        }
        let name = unquote(entry[..start].trim());
        let display = if name.is_empty() {
            address.to_owned()
        } else {
            name
        };
        return Some(AddressIdentity {
            display,
            address: address.to_owned(),
        });
    }
    Some(AddressIdentity {
        display: entry.to_owned(),
        address: entry.to_owned(),
    })
}

fn unquote(value: &str) -> String {
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        value[1..value.len() - 1].to_owned()
    } else {
        value.to_owned()
    }
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
        None
    } else {
        Some(domain)
    }
}
