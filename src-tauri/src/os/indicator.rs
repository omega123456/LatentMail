use crate::storage::{AccountRepository, LabelRepository, Storage};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndicatorState {
    pub unread_count: u64,
    pub needs_reauthentication: bool,
}

impl IndicatorState {
    pub fn empty() -> Self {
        Self {
            unread_count: 0,
            needs_reauthentication: false,
        }
    }

    pub fn badge(&self) -> Option<String> {
        if self.needs_reauthentication {
            Some("!".to_owned())
        } else if self.unread_count == 0 {
            None
        } else if self.unread_count > 99 {
            Some("99+".to_owned())
        } else {
            Some(self.unread_count.to_string())
        }
    }

    pub fn tooltip(&self) -> String {
        if self.needs_reauthentication {
            format!(
                "LatentMail — {} unread — account needs re-authentication",
                self.unread_count
            )
        } else {
            format!("LatentMail — {} unread", self.unread_count)
        }
    }

    pub fn status_row(&self) -> String {
        if self.needs_reauthentication {
            format!(
                "{} unread messages — account needs re-authentication",
                self.unread_count
            )
        } else {
            format!("{} unread messages", self.unread_count)
        }
    }
}

pub async fn aggregate(storage: &Storage) -> Result<IndicatorState, String> {
    storage
        .run(|connection| {
            let accounts = AccountRepository::list(connection)?;
            let unread_count = accounts.iter().try_fold(0_u64, |total, account| {
                let count = LabelRepository::unread_thread_counts(connection, &account.id)?
                    .get("INBOX")
                    .copied()
                    .unwrap_or(0);
                Ok::<_, rusqlite::Error>(total.saturating_add(u64::try_from(count).unwrap_or(0)))
            })?;
            Ok(IndicatorState {
                unread_count,
                needs_reauthentication: accounts
                    .iter()
                    .any(|account| account.needs_reauthentication),
            })
        })
        .await
        .map_err(|error| error.to_string())
}
