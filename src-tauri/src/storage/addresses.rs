//! The one RFC 5322 address-list splitter in the storage layer (D12).
//!
//! Thread participants are historically stored as a comma-joined string and
//! split on a bare comma. A quoted display name containing a comma —
//! `"Kovacs, Jozsef" <j@example.com>`, routine in corporate mail — splits
//! into two bogus entries under that approach. This module is the fix:
//! everything that needs to turn a raw header value into individual
//! addresses, or a single address into a display label and a bare address,
//! goes through here. Nothing else in storage may split on a bare comma.

/// One resolved participant: a display label (the quoted name if present,
/// otherwise the bare address) and the bare address itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddressIdentity {
    pub display: String,
    pub address: String,
}

/// Splits an RFC 5322 address-list header into individual entries,
/// respecting double-quoted display names so a comma inside quotes never
/// splits one participant into two. This is intentionally a light-weight
/// quote-aware scanner, not a full RFC 5322 grammar — it covers the quoting
/// rule that actually bites (display names), not the full production set.
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

/// Parses one address-list entry — `"Display Name" <addr@example.com>` or a
/// bare `addr@example.com` — into a display label and a bare address.
/// Returns `None` when the entry carries no recoverable address at all.
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

/// Splits `header` and parses its first recoverable address — the common
/// case for thread-summary identity resolution, which only ever needs one
/// party (the newest sender, or the newest Sent message's first recipient).
pub fn first_identity(header: &str) -> Option<AddressIdentity> {
    split_addresses(header)
        .into_iter()
        .find_map(|entry| parse_address(&entry))
}

/// The domain portion of a bare address, lower-cased. `None` when the
/// address carries no `@` or an empty domain.
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
