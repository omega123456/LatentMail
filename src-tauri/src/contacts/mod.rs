use std::collections::HashMap;

use chrono::Utc;
use rusqlite::{params, Connection, Result};

use crate::storage::addresses::{self, Mailbox};

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

pub struct ContactObservation<'a> {
    pub account_id: &'a str,
    pub mailbox: &'a str,
    pub seen_at: i64,
}

struct AggregatedContact {
    display_name: Option<String>,
    display_seen_at: i64,
    frequency: i64,
    last_seen_at: i64,
}

pub fn observe(connection: &Connection, observation: ContactObservation<'_>) -> Result<()> {
    let Some(Mailbox { name, address }) = learnable_mailbox(observation.mailbox) else {
        return Ok(());
    };
    connection.execute(
        UPSERT_CONTACT,
        params![
            observation.account_id,
            address,
            name,
            1,
            observation.seen_at,
            observation.seen_at
        ],
    )?;
    Ok(())
}

pub fn observe_many(
    connection: &Connection,
    account_id: &str,
    observations: &[(String, i64)],
) -> Result<()> {
    let mut contacts: HashMap<String, AggregatedContact> = HashMap::new();
    for (mailbox, seen_at) in observations {
        let Some(Mailbox {
            name: display_name,
            address,
        }) = learnable_mailbox(mailbox)
        else {
            continue;
        };
        let contact = contacts
            .entry(address)
            .or_insert_with(|| AggregatedContact {
                display_name: None,
                display_seen_at: i64::MIN,
                frequency: 0,
                last_seen_at: *seen_at,
            });
        contact.frequency += 1;
        contact.last_seen_at = contact.last_seen_at.max(*seen_at);
        if display_name.is_some() && *seen_at >= contact.display_seen_at {
            contact.display_name = display_name;
            contact.display_seen_at = *seen_at;
        }
    }
    let mut statement = connection.prepare(UPSERT_CONTACT)?;
    for (address, contact) in contacts {
        statement.execute(params![
            account_id,
            address,
            contact.display_name,
            contact.frequency,
            contact.last_seen_at,
            contact.display_seen_at
        ])?;
    }
    Ok(())
}

pub fn observe_now(connection: &Connection, account_id: &str, mailbox: &str) -> Result<()> {
    observe(
        connection,
        ContactObservation {
            account_id: account_id,
            mailbox: mailbox,
            seen_at: Utc::now().timestamp(),
        },
    )
}

pub fn lookup(connection: &Connection, account_id: &str, prefix: &str) -> Result<Vec<Contact>> {
    let prefix = format!("{}%", prefix.trim().to_ascii_lowercase());
    let mut statement = connection.prepare_cached(
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

fn learnable_mailbox(mailbox: &str) -> Option<Mailbox> {
    let parsed = addresses::parse_mailbox(mailbox)?;
    Some(Mailbox {
        name: parsed.name,
        address: parsed.address.to_ascii_lowercase(),
    })
}
