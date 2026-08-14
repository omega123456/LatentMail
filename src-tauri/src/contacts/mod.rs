use std::collections::HashMap;

use chrono::Utc;
use rusqlite::{params, Connection, Result};

const UPSERT_CONTACT: &str =
    "INSERT INTO contacts (account_id,address,display_name,frequency,last_seen_at) VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(account_id,address) DO UPDATE SET
       frequency=contacts.frequency+excluded.frequency,
       last_seen_at=MAX(contacts.last_seen_at, excluded.last_seen_at),
       display_name=CASE WHEN excluded.display_name IS NOT NULL AND ?6 >= contacts.last_seen_at THEN excluded.display_name ELSE contacts.display_name END";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contact {
    pub account_id: String,
    pub address: String,
    pub display_name: Option<String>,
    pub frequency: i64,
    pub last_seen_at: i64,
}

pub fn observe(
    connection: &Connection,
    account_id: &str,
    mailbox: &str,
    seen_at: i64,
) -> Result<()> {
    let (display_name, address) = parse_mailbox(mailbox);
    if address.is_empty() {
        return Ok(());
    }
    connection.execute(
        UPSERT_CONTACT,
        params![account_id, address, display_name, 1, seen_at, seen_at],
    )?;
    Ok(())
}

pub fn observe_many(
    connection: &Connection,
    account_id: &str,
    observations: &[(String, i64)],
) -> Result<()> {
    let mut contacts: HashMap<String, (Option<String>, i64, i64, i64)> = HashMap::new();
    for (mailbox, seen_at) in observations {
        let (display_name, address) = parse_mailbox(mailbox);
        if address.is_empty() {
            continue;
        }
        let contact = contacts
            .entry(address)
            .or_insert_with(|| (None, i64::MIN, 0, *seen_at));
        contact.2 += 1;
        contact.3 = contact.3.max(*seen_at);
        if display_name.is_some() && *seen_at >= contact.1 {
            contact.0 = display_name;
            contact.1 = *seen_at;
        }
    }
    let mut statement = connection.prepare(UPSERT_CONTACT)?;
    for (address, (display_name, display_seen_at, frequency, last_seen_at)) in contacts {
        statement.execute(params![
            account_id,
            address,
            display_name,
            frequency,
            last_seen_at,
            display_seen_at
        ])?;
    }
    Ok(())
}

pub fn observe_now(connection: &Connection, account_id: &str, mailbox: &str) -> Result<()> {
    observe(connection, account_id, mailbox, Utc::now().timestamp())
}

pub fn lookup(connection: &Connection, account_id: &str, prefix: &str) -> Result<Vec<Contact>> {
    let prefix = format!("{}%", prefix.trim().to_ascii_lowercase());
    let mut statement = connection.prepare(
        "SELECT account_id,address,display_name,frequency,last_seen_at FROM contacts
         WHERE account_id=?1 AND address LIKE ?2
         ORDER BY frequency DESC,last_seen_at DESC,address ASC LIMIT 10",
    )?;
    let contacts = statement
        .query_map(params![account_id, prefix], |row| {
            Ok(Contact {
                account_id: row.get(0)?,
                address: row.get(1)?,
                display_name: row.get(2)?,
                frequency: row.get(3)?,
                last_seen_at: row.get(4)?,
            })
        })?
        .collect();
    contacts
}

fn parse_mailbox(value: &str) -> (Option<String>, String) {
    let value = value.trim();
    if let (Some(start), Some(end)) = (value.rfind('<'), value.rfind('>')) {
        let name = value[..start].trim().trim_matches('"');
        return (
            (if name.is_empty() {
                None
            } else {
                Some(name.to_owned())
            }),
            value[start + 1..end].trim().to_ascii_lowercase(),
        );
    }
    (None, value.to_ascii_lowercase())
}
