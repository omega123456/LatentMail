use std::collections::HashMap;

use super::{DraftUploadRequest, GetRequest, SendRequest};
use crate::gmail::mapping::map_message;
use crate::gmail::wire::{RawDraft, RawDraftList, RawId, SendDraftRequest};
use crate::gmail::{
    DraftContent, GmailClient, GmailDraft, GmailError, DRAFTS_CREATE_COST, DRAFTS_GET_COST,
    DRAFTS_LIST_COST, DRAFTS_UPDATE_COST, MESSAGES_SEND_COST,
};

impl GmailClient {
    pub async fn create_draft(
        &self,
        raw: &[u8],
        thread_id: Option<&str>,
    ) -> Result<String, GmailError> {
        self.upload_draft(DraftUploadRequest {
            method: reqwest::Method::POST,
            path: "/users/me/drafts",
            raw: raw,
            thread_id: thread_id,
            cost: DRAFTS_CREATE_COST,
        })
        .await
    }

    pub async fn update_draft(
        &self,
        draft_id: &str,
        content: DraftContent<'_>,
    ) -> Result<String, GmailError> {
        self.upload_draft(DraftUploadRequest {
            method: reqwest::Method::PUT,
            path: &format!("/users/me/drafts/{draft_id}"),
            raw: content.raw,
            thread_id: content.thread_id,
            cost: DRAFTS_UPDATE_COST,
        })
        .await
    }

    pub async fn draft(&self, draft_id: &str) -> Result<GmailDraft, GmailError> {
        let raw: RawDraft = self
            .get(GetRequest {
                path: &format!("/users/me/drafts/{draft_id}"),
                query: &[("format".into(), "full".into())],
                cost: DRAFTS_GET_COST,
                history: false,
            })
            .await?;
        Ok(GmailDraft {
            id: raw.id,
            message: map_message(raw.message.into_raw()?),
        })
    }

    pub async fn send_draft(&self, draft_id: &str) -> Result<String, GmailError> {
        let raw: RawId = self
            .send(SendRequest {
                method: reqwest::Method::POST,
                path: "/users/me/drafts/send",
                body: &SendDraftRequest { id: draft_id },
                cost: MESSAGES_SEND_COST,
                history: false,
            })
            .await?;
        Ok(raw.id)
    }

    pub async fn list_draft_ids(&self) -> Result<HashMap<String, String>, GmailError> {
        let mut mapping = HashMap::new();
        let mut next_token = collect_draft_page(&mut mapping, self.list_drafts_page(None).await?);
        while let Some(token) = next_token {
            let page = self.list_drafts_page(Some(&token)).await?;
            next_token = collect_draft_page(&mut mapping, page);
        }
        Ok(mapping)
    }

    async fn list_drafts_page(&self, page_token: Option<&str>) -> Result<RawDraftList, GmailError> {
        let mut query = vec![(
            "fields".to_owned(),
            "drafts(id,message/id),nextPageToken".to_owned(),
        )];
        if let Some(token) = page_token {
            query.push(("pageToken".to_owned(), token.to_owned()));
        }
        self.get(GetRequest {
            path: "/users/me/drafts",
            query: &query,
            cost: DRAFTS_LIST_COST,
            history: false,
        })
        .await
    }
}

fn collect_draft_page(mapping: &mut HashMap<String, String>, page: RawDraftList) -> Option<String> {
    for draft in page.drafts.unwrap_or_default() {
        mapping.insert(draft.message.id, draft.id);
    }
    page.next_page_token
}
