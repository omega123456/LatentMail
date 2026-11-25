use reqwest::StatusCode;

use super::{ApiRequest, GetRequest, SendRequest};
use crate::gmail::mapping::{decode, map_message};
use crate::gmail::wire::{
    BatchModifyRequest, ModifyRequest, RawAttachment, RawMessage, RawMessageList, RawSource,
};
use crate::gmail::{
    GmailClient, GmailError, GmailMessage, LabelModification, ListOptions, MessageListQuery,
    MessageRef, Page, ATTACHMENTS_GET_COST, LIST_FIELDS, MAX_ATTACHMENT_RESPONSE_BYTES,
    MAX_PAGE_SIZE, MAX_RAW_MESSAGE_RESPONSE_BYTES, MESSAGES_BATCH_MODIFY_COST, MESSAGES_GET_COST,
    MESSAGES_LIST_COST, MESSAGES_MODIFY_COST, MESSAGE_FIELDS, MESSAGE_METADATA_FIELDS,
};

impl GmailClient {
    pub async fn list_messages_page(
        &self,
        label_ids: &[String],
        page_token: Option<&str>,
    ) -> Result<Page<MessageRef>, GmailError> {
        self.list_messages_page_matching(MessageListQuery {
            label_ids: label_ids,
            query_filter: None,
            page_token: page_token,
            options: ListOptions::default(),
        })
        .await
    }

    pub async fn list_all_messages(
        &self,
        label_ids: &[String],
    ) -> Result<Vec<MessageRef>, GmailError> {
        self.list_all_messages_matching(MessageListQuery {
            label_ids: label_ids,
            query_filter: None,
            page_token: None,
            options: ListOptions::default(),
        })
        .await
    }

    pub async fn list_messages_page_matching(
        &self,
        request: MessageListQuery<'_>,
    ) -> Result<Page<MessageRef>, GmailError> {
        let mut query = vec![("fields".to_owned(), LIST_FIELDS.to_owned())];
        for label in request.label_ids {
            query.push(("labelIds".to_owned(), label.clone()));
        }
        if let Some(filter) = request.query_filter {
            query.push(("q".to_owned(), filter.to_owned()));
        }
        if let Some(token) = request.page_token {
            query.push(("pageToken".to_owned(), token.into()));
        }
        if request.options.include_spam_and_trash {
            query.push(("includeSpamTrash".to_owned(), "true".to_owned()));
        }
        query.push((
            "maxResults".to_owned(),
            request.options.page_size.min(MAX_PAGE_SIZE).to_string(),
        ));
        let raw: RawMessageList = self
            .get_list_page(GetRequest {
                path: "/users/me/messages",
                query: &query,
                cost: MESSAGES_LIST_COST,
                history: false,
            })
            .await?;
        Ok(Page {
            items: raw
                .messages
                .unwrap_or_default()
                .into_iter()
                .map(|message| MessageRef {
                    id: message.id,
                    thread_id: message.thread_id.unwrap_or_default(),
                })
                .collect(),
            next_page_token: raw.next_page_token,
        })
    }

    pub async fn list_all_messages_matching(
        &self,
        request: MessageListQuery<'_>,
    ) -> Result<Vec<MessageRef>, GmailError> {
        let mut page = self
            .list_messages_page_matching(MessageListQuery {
                label_ids: request.label_ids,
                query_filter: request.query_filter,
                page_token: request.page_token,
                options: request.options,
            })
            .await?;
        let mut all = page.items;
        while let Some(token) = page.next_page_token {
            page = self
                .list_messages_page_matching(MessageListQuery {
                    label_ids: request.label_ids,
                    query_filter: request.query_filter,
                    page_token: Some(&token),
                    options: request.options,
                })
                .await?;
            all.extend(page.items);
        }
        Ok(all)
    }

    pub async fn message(&self, id: &str) -> Result<GmailMessage, GmailError> {
        let result: Result<RawMessage, GmailError> = self
            .get(GetRequest {
                path: &format!("/users/me/messages/{id}"),
                query: &[("fields".to_owned(), MESSAGE_FIELDS.into())],
                cost: MESSAGES_GET_COST,
                history: false,
            })
            .await;
        match result {
            Ok(raw) => Ok(map_message(raw)),
            Err(GmailError::ResponseTooLarge) => {
                let raw: RawMessage = self
                    .get(GetRequest {
                        path: &format!("/users/me/messages/{id}"),
                        query: &[
                            ("format".to_owned(), "metadata".to_owned()),
                            ("fields".to_owned(), MESSAGE_METADATA_FIELDS.to_owned()),
                        ],
                        cost: MESSAGES_GET_COST,
                        history: false,
                    })
                    .await?;
                let mut message = map_message(raw);
                message.oversize = true;
                Ok(message)
            }
            Err(other) => Err(other),
        }
    }

    pub async fn message_if_present(&self, id: &str) -> Result<Option<GmailMessage>, GmailError> {
        match self.message(id).await {
            Err(GmailError::Http(status)) if status == StatusCode::NOT_FOUND.as_u16() => Ok(None),
            other => other.map(Some),
        }
    }

    pub async fn attachment(
        &self,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<Vec<u8>, GmailError> {
        self.acquire(ATTACHMENTS_GET_COST).await;
        let path = format!("/users/me/messages/{message_id}/attachments/{attachment_id}");
        let raw: RawAttachment = self
            .request_capped(
                ApiRequest {
                    method: reqwest::Method::GET,
                    path: &path,
                    query: Vec::new(),
                    body: Option::<&()>::None,
                    history: false,
                },
                MAX_ATTACHMENT_RESPONSE_BYTES,
            )
            .await?;
        decode(&raw.data).ok_or(GmailError::AttachmentData)
    }

    pub async fn raw_message(&self, id: &str) -> Result<Vec<u8>, GmailError> {
        self.acquire(MESSAGES_GET_COST).await;
        let path = format!("/users/me/messages/{id}");
        let source: RawSource = self
            .request_capped(
                ApiRequest {
                    method: reqwest::Method::GET,
                    path: &path,
                    query: vec![("format", "raw")],
                    body: Option::<&()>::None,
                    history: false,
                },
                MAX_RAW_MESSAGE_RESPONSE_BYTES,
            )
            .await?;
        decode(&source.raw).ok_or(GmailError::RawMessageData)
    }

    pub async fn modify_message(
        &self,
        id: &str,
        labels: LabelModification<'_>,
    ) -> Result<GmailMessage, GmailError> {
        let raw: RawMessage = self
            .send(SendRequest {
                method: reqwest::Method::POST,
                path: &format!("/users/me/messages/{id}/modify"),
                body: &ModifyRequest {
                    add_label_ids: labels.add_label_ids,
                    remove_label_ids: labels.remove_label_ids,
                },
                cost: MESSAGES_MODIFY_COST,
                history: false,
            })
            .await?;
        Ok(map_message(raw))
    }

    pub async fn batch_modify(
        &self,
        ids: &[String],
        labels: LabelModification<'_>,
    ) -> Result<(), GmailError> {
        let _: serde_json::Value = self
            .send(SendRequest {
                method: reqwest::Method::POST,
                path: "/users/me/messages/batchModify",
                body: &BatchModifyRequest {
                    ids: ids,
                    add_label_ids: labels.add_label_ids,
                    remove_label_ids: labels.remove_label_ids,
                },
                cost: MESSAGES_BATCH_MODIFY_COST,
                history: false,
            })
            .await?;
        Ok(())
    }
}
