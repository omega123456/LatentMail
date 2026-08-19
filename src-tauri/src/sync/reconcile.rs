use std::collections::{HashMap, HashSet};

use crate::{
    attachments::AttachmentCache,
    contacts,
    gmail::{GmailClient, ListOptions, MAX_PAGE_SIZE},
    queue::QueueEngine,
    storage::{
        Label, LabelRepository, MessageRepository, Storage, ThreadRepository, TraversalCursor,
        TraversalCursorRepository, TraversalKind,
    },
};

use super::{to_label, traversal, EventSink, FullSyncOutcome, SyncError};

pub async fn run(
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
    events: &EventSink,
    queue: Option<&QueueEngine>,
    cache: Option<AttachmentCache>,
) -> Result<FullSyncOutcome, SyncError> {
    let history_checkpoint = client.profile().await?.history_id;
    let gmail_labels = client.labels().await?;
    let options = ListOptions {
        include_spam_and_trash: true,
        page_size: MAX_PAGE_SIZE,
    };

    let account = account_id.to_owned();
    storage
        .run(move |connection| {
            TraversalCursorRepository::upsert(
                connection,
                &TraversalCursor {
                    account_id: account,
                    kind: TraversalKind::Reconciliation,
                    position: Some("universe".into()),
                    discovered_count: 0,
                    persisted_count: 0,
                    completed: false,
                    last_advanced_at: chrono::Utc::now().timestamp(),
                    resumed: false,
                },
            )
        })
        .await?;

    let mut universe = HashSet::new();
    let mut discovered_count: i64;
    let mut token = None;
    loop {
        if let Some(queue) = queue {
            queue.wait_until_resumed().await;
        }
        let page = client
            .list_messages_page_matching(&[], None, token.as_deref(), options)
            .await?;
        universe.extend(page.items.iter().map(|message| message.id.clone()));
        discovered_count = universe.len() as i64;
        let complete = page.next_page_token.is_none();
        checkpoint(
            storage,
            account_id,
            format!(
                "universe:{}",
                page.next_page_token.as_deref().unwrap_or("done")
            ),
            discovered_count,
            discovered_count,
            false,
        )
        .await?;
        traversal::emit_traversal_progress(
            events,
            traversal::TraversalProgressEvent {
                account_id: account_id.to_owned(),
                kind: "reconciliation",
                discovered_count,
                persisted_count: discovered_count,
                completed: false,
            },
        );
        if complete {
            break;
        }
        token = page.next_page_token;
    }

    let local_ids: HashSet<String> = storage
        .run({
            let account_id = account_id.to_owned();
            move |connection| MessageRepository::all_ids(connection, &account_id)
        })
        .await?
        .into_iter()
        .collect();
    let new_ids: Vec<String> = universe.difference(&local_ids).cloned().collect();

    let mut persisted_count = discovered_count - new_ids.len() as i64;

    let mut memberships: HashMap<String, Vec<String>> =
        universe.iter().map(|id| (id.clone(), Vec::new())).collect();
    for label in &gmail_labels {
        let mut token = None;
        loop {
            if let Some(queue) = queue {
                queue.wait_until_resumed().await;
            }
            let page = client
                .list_messages_page_matching(
                    std::slice::from_ref(&label.id),
                    None,
                    token.as_deref(),
                    options,
                )
                .await?;
            for message in &page.items {
                if let Some(labels) = memberships.get_mut(&message.id) {
                    labels.push(label.id.clone());
                }
            }
            let complete = page.next_page_token.is_none();
            checkpoint(
                storage,
                account_id,
                format!(
                    "label:{}:{}",
                    label.id,
                    page.next_page_token.as_deref().unwrap_or("done")
                ),
                discovered_count,
                persisted_count,
                false,
            )
            .await?;
            traversal::emit_traversal_progress(
                events,
                traversal::TraversalProgressEvent {
                    account_id: account_id.to_owned(),
                    kind: "reconciliation",
                    discovered_count,
                    persisted_count,
                    completed: false,
                },
            );
            if complete {
                break;
            }
            token = page.next_page_token;
        }
    }


    let mut fetched_threads = Vec::new();
    for ids in new_ids.chunks(MAX_PAGE_SIZE as usize) {
        if let Some(queue) = queue {
            queue.wait_until_resumed().await;
        }
        fetched_threads.extend(
            traversal::fetch_and_persist(storage, client, account_id, ids, cache.clone()).await?,
        );
        persisted_count += ids.len() as i64;
        checkpoint(
            storage,
            account_id,
            format!("fetch:{}", persisted_count),
            discovered_count,
            persisted_count,
            false,
        )
        .await?;
        traversal::emit_traversal_progress(
            events,
            traversal::TraversalProgressEvent {
                account_id: account_id.to_owned(),
                kind: "reconciliation",
                discovered_count,
                persisted_count,
                completed: false,
            },
        );
    }

    let account_owned = account_id.to_owned();
    let labels: Vec<Label> = gmail_labels
        .iter()
        .map(|label| to_label(&account_owned, label))
        .collect();
    let touched_threads = storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            for label in &labels {
                LabelRepository::upsert(&transaction, label)?;
            }
            let current = MessageRepository::reconciliation_messages(&transaction, &account_owned)?;
            let mut touched = HashSet::new();
            for id in current.keys().filter(|id| !universe.contains(*id)) {
                if let Some(thread_id) =
                    MessageRepository::delete(&transaction, &account_owned, id)?
                {
                    touched.insert(thread_id);
                }
            }
            for (id, label_ids) in &memberships {
                if let Some(message) = current.get(id) {

                    let current_label_ids: HashSet<&str> =
                        message.label_ids.iter().map(String::as_str).collect();
                    let wanted_label_ids: HashSet<&str> =
                        label_ids.iter().map(String::as_str).collect();
                    if current_label_ids != wanted_label_ids {
                        MessageRepository::overwrite_membership(
                            &transaction,
                            &account_owned,
                            id,
                            label_ids,
                        )?;
                        touched.insert(message.thread_id.clone());
                    }
                }
            }

            let mut contact_observations = Vec::new();
            for id in &universe {
                if let Some(message) = current.get(id) {
                    contact_observations.push((message.sender.clone(), message.sent_at));
                    if memberships
                        .get(id)
                        .is_some_and(|labels| labels.iter().any(|label| label == "SENT"))
                    {
                        for mailbox in message
                            .to_recipients
                            .split(',')
                            .chain(message.cc_recipients.split(','))
                            .map(str::trim)
                            .filter(|mailbox| !mailbox.is_empty())
                        {
                            contact_observations.push((mailbox.to_owned(), message.sent_at));
                        }
                    }
                }
            }
            contacts::observe_many(&transaction, &account_owned, &contact_observations)?;
            ThreadRepository::recompute_many(&transaction, &account_owned, &touched)?;
            TraversalCursorRepository::upsert(
                &transaction,
                &TraversalCursor {
                    account_id: account_owned.clone(),
                    kind: TraversalKind::Reconciliation,
                    position: None,
                    discovered_count,
                    persisted_count,
                    completed: true,
                    last_advanced_at: chrono::Utc::now().timestamp(),
                    resumed: false,
                },
            )?;
            transaction.commit()?;
            Ok(touched.into_iter().collect::<Vec<_>>())
        })
        .await?;

    let thread_ids = fetched_threads
        .into_iter()
        .chain(touched_threads)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    traversal::emit_traversal_progress(
        events,
        traversal::TraversalProgressEvent {
            account_id: account_id.to_owned(),
            kind: "reconciliation",
            discovered_count,
            persisted_count,
            completed: true,
        },
    );
    Ok(FullSyncOutcome {
        history_id: history_checkpoint,
        added_count: new_ids.len() as u32,
        thread_ids,
        changed: true,

        arrivals: Vec::new(),
    })
}

async fn checkpoint(
    storage: &Storage,
    account_id: &str,
    position: String,
    discovered_count: i64,
    persisted_count: i64,
    completed: bool,
) -> Result<(), SyncError> {
    let account_id = account_id.to_owned();
    storage
        .run(move |connection| {
            TraversalCursorRepository::upsert(
                connection,
                &TraversalCursor {
                    account_id,
                    kind: TraversalKind::Reconciliation,
                    position: Some(position),
                    discovered_count,
                    persisted_count,
                    completed,
                    last_advanced_at: chrono::Utc::now().timestamp(),
                    resumed: false,
                },
            )
        })
        .await?;
    Ok(())
}
