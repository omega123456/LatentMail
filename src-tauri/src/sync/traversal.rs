use std::collections::HashSet;

use serde::Serialize;

use crate::{
    attachments::AttachmentCache,
    gmail::{GmailClient, GmailMessage, ListOptions, MAX_PAGE_SIZE},
    storage::{
        AttachmentRepository, HtmlPresence, LabelRepository, Message, MessageRepository, Storage,
        ThreadRepository, TraversalCursor, TraversalCursorRepository, TraversalKind,
    },
};

use super::materialize::attachment_records;

use super::{concurrency, to_millis, EventSink, SyncError, TraversalState};

pub fn traversal_entity_key(account_id: &str) -> String {
    format!("traversal:{account_id}")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraversalProgressEvent {
    pub account_id: String,
    pub kind: &'static str,
    pub discovered_count: i64,
    pub persisted_count: i64,
    pub completed: bool,
    pub state: TraversalState,
    pub last_advanced_at: i64,
    pub is_resumed: bool,
}

pub fn emit_traversal_progress(sink: &EventSink, event: TraversalProgressEvent) {
    sink(
        "sync://traversal",
        serde_json::to_value(event).expect("TraversalProgressEvent always serializes"),
    );
}

pub async fn run_backfill_step(
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
    events: &EventSink,
    resumed: bool,
    cache: Option<AttachmentCache>,
) -> Result<bool, SyncError> {
    let existing = storage
        .run({
            let account = account_id.to_owned();
            move |connection| {
                TraversalCursorRepository::get(connection, &account, TraversalKind::Backfill)
            }
        })
        .await?;

    if let Some(cursor) = &existing {
        if cursor.completed {
            return Ok(true);
        }
    }

    let needs_mailbox_total = existing
        .as_ref()
        .is_none_or(|cursor| cursor.discovered_count <= cursor.persisted_count);
    let (token, discovered, persisted) = match existing {
        Some(cursor) => (
            cursor.position,
            cursor.discovered_count,
            cursor.persisted_count,
        ),
        None => (None, 0, 0),
    };

    let discovered = if needs_mailbox_total {
        client.profile().await?.messages_total
    } else {
        discovered
    };

    let options = ListOptions {
        include_spam_and_trash: true,
        page_size: MAX_PAGE_SIZE,
    };

    let page = client
        .list_messages_page_matching(&[], None, token.as_deref(), options)
        .await?;
    let is_last_page = page.next_page_token.is_none();
    let next_token = page.next_page_token.clone();
    let ids: Vec<String> = page.items.iter().map(|item| item.id.clone()).collect();

    let messages = concurrency::fetch_messages(client, ids).await?;

    let persisted = persisted + messages.len() as i64;
    let account_owned = account_id.to_owned();
    let position = next_token;
    let now = chrono::Utc::now().timestamp();
    storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let mut touched = HashSet::new();
            for message in &messages {
                touched.insert(message.thread_id.clone());
                write_traversal_message(&transaction, &account_owned, message, cache.as_ref())?;
            }
            ThreadRepository::recompute_many(&transaction, &account_owned, &touched)?;

            TraversalCursorRepository::upsert(
                &transaction,
                &TraversalCursor {
                    account_id: account_owned.clone(),
                    kind: TraversalKind::Backfill,
                    position,
                    discovered_count: discovered,
                    persisted_count: persisted,
                    completed: is_last_page,
                    last_advanced_at: now,
                    resumed,
                },
            )?;
            transaction.commit()
        })
        .await?;

    emit_traversal_progress(
        events,
        TraversalProgressEvent {
            account_id: account_id.to_owned(),
            kind: "backfill",
            discovered_count: discovered,
            persisted_count: persisted,
            completed: is_last_page,
            state: if is_last_page {
                TraversalState::Complete
            } else {
                TraversalState::Backfilling
            },
            last_advanced_at: to_millis(now),
            is_resumed: resumed,
        },
    );

    Ok(is_last_page)
}

pub async fn fetch_and_persist(
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
    ids: &[String],
    cache: Option<AttachmentCache>,
) -> Result<Vec<String>, SyncError> {
    let messages = concurrency::fetch_messages(client, ids.to_vec()).await?;
    let account_owned = account_id.to_owned();
    let thread_ids = storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let mut touched = HashSet::new();
            for message in &messages {
                touched.insert(message.thread_id.clone());
                write_traversal_message(&transaction, &account_owned, message, cache.as_ref())?;
            }
            ThreadRepository::recompute_many(&transaction, &account_owned, &touched)?;
            transaction.commit()?;
            Ok(touched.into_iter().collect::<Vec<_>>())
        })
        .await?;
    Ok(thread_ids)
}

fn write_traversal_message(
    connection: &rusqlite::Connection,
    account_id: &str,
    message: &GmailMessage,
    cache: Option<&AttachmentCache>,
) -> rusqlite::Result<()> {
    let truncated_body =
        crate::storage::truncate_body(message.plain_body.as_deref(), message.html_body.as_deref());
    let record = Message {
        account_id: account_id.to_owned(),
        id: message.id.clone(),
        thread_id: message.thread_id.clone(),
        rfc_message_id: message.rfc_message_id.clone(),
        sender: message.sender.clone(),
        recipients: message.recipients.clone(),
        subject: message.subject.clone(),
        sent_at: message.sent_at,
        snippet: message.snippet.clone(),

        html_body: None,
        plain_body: None,
        has_attachments: message.has_attachments,
        is_unread: message.label_ids.iter().any(|id| id == "UNREAD"),
        is_starred: message.label_ids.iter().any(|id| id == "STARRED"),
        history_id: message.history_id,
        truncated_body,
        html_presence: if message.oversize {
            HtmlPresence::TooLarge
        } else {
            HtmlPresence::NeverFetched
        },
    };
    let changed = MessageRepository::write_traversal_state(connection, &record)?;
    if changed {
        MessageRepository::set_recipient_roles(
            connection,
            account_id,
            &message.id,
            &message.to_recipients,
            &message.cc_recipients,
            &message.bcc_recipients,
            message.rfc_references.as_deref(),
        )?;
        for label_id in &message.label_ids {
            LabelRepository::ensure_placeholder(connection, account_id, label_id)?;
            MessageRepository::set_label_membership(
                connection,
                account_id,
                &message.id,
                label_id,
                true,
            )?;
        }
    }

    AttachmentRepository::replace_for_message(
        connection,
        account_id,
        &message.id,
        &attachment_records(message),
    )?;
    if let Some(cache) = cache {
        crate::attachments::seed_cache(cache, account_id, &message.id, &message.attachment_parts);
    }
    Ok(())
}
