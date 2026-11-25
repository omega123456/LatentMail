use super::GetRequest;
use crate::gmail::mapping::{map_history, number};
use crate::gmail::wire::{RawHistory, RawLabels, RawProfile};
use crate::gmail::{
    labels, GmailClient, GmailError, GmailLabel, HistoryPage, Profile, HISTORY_LIST_COST,
    LABELS_LIST_COST, PROFILE_COST,
};

impl GmailClient {
    pub async fn profile(&self) -> Result<Profile, GmailError> {
        let raw: RawProfile = self
            .get(GetRequest {
                path: "/users/me/profile",
                query: &[],
                cost: PROFILE_COST,
                history: false,
            })
            .await?;
        Ok(Profile {
            email_address: raw.email_address,
            messages_total: raw.messages_total,
            threads_total: raw.threads_total,
            history_id: number(&raw.history_id),
        })
    }

    pub async fn labels(&self) -> Result<Vec<GmailLabel>, GmailError> {
        let raw: RawLabels = self
            .get(GetRequest {
                path: "/users/me/labels",
                query: &[],
                cost: LABELS_LIST_COST,
                history: false,
            })
            .await?;
        Ok(raw.labels.into_iter().map(labels::map_label).collect())
    }

    pub async fn history_page(
        &self,
        start_history_id: i64,
        page_token: Option<&str>,
    ) -> Result<HistoryPage, GmailError> {
        let mut query = vec![("startHistoryId".to_owned(), start_history_id.to_string())];
        if let Some(token) = page_token {
            query.push(("pageToken".to_owned(), token.to_owned()));
        }
        let raw: RawHistory = self
            .get(GetRequest {
                path: "/users/me/history",
                query: &query,
                cost: HISTORY_LIST_COST,
                history: true,
            })
            .await?;
        Ok(HistoryPage {
            history_id: number(&raw.history_id),
            records: raw
                .history
                .unwrap_or_default()
                .into_iter()
                .map(map_history)
                .collect(),
            next_page_token: raw.next_page_token,
        })
    }
}
