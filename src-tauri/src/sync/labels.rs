use std::collections::{HashMap, HashSet};

use crate::{
    gmail::GmailLabel,
    storage::{Label, LabelColor, LabelRepository},
};

const USER_LABEL_ID_PREFIX: &str = "Label_";

pub(crate) struct LabelSyncTarget<'a> {
    pub account_id: &'a str,
    pub gmail_labels: &'a [GmailLabel],
}

pub(crate) fn sync_labels(
    connection: &rusqlite::Connection,
    target: LabelSyncTarget<'_>,
    touched_threads: &mut HashSet<String>,
) -> rusqlite::Result<bool> {
    let desired: Vec<Label> = target
        .gmail_labels
        .iter()
        .map(|label| to_label(target.account_id, label))
        .collect();
    let remote_ids: HashSet<&str> = desired.iter().map(|label| label.id.as_str()).collect();
    let existing = LabelRepository::list(connection, target.account_id)?;
    let stale: Vec<&str> = existing
        .iter()
        .filter(|label| {
            (label.kind == "user" || label.id.starts_with(USER_LABEL_ID_PREFIX))
                && !remote_ids.contains(label.id.as_str())
        })
        .map(|label| label.id.as_str())
        .collect();
    let existing_by_id: HashMap<&str, &Label> = existing
        .iter()
        .map(|label| (label.id.as_str(), label))
        .collect();
    let changed = !stale.is_empty()
        || desired
            .iter()
            .any(|label| existing_by_id.get(label.id.as_str()) != Some(&label));
    tracing::info!(
        target: "sync",
        "{}: labels — {} remote, {} local, pruning {:?}",
        target.account_id,
        desired.len(),
        existing.len(),
        stale,
    );
    for label_id in &stale {
        touched_threads.extend(LabelRepository::threads_with_label(
            connection,
            target.account_id,
            label_id,
        )?);
        LabelRepository::delete(connection, target.account_id, label_id)?;
    }
    for label in &desired {
        LabelRepository::upsert(connection, label)?;
    }
    Ok(changed)
}

pub(crate) fn to_label(account_id: &str, label: &GmailLabel) -> Label {
    let color = (label.kind == "user")
        .then_some(label.color.as_ref())
        .flatten()
        .map(|pair| LabelColor {
            text: pair.text_color.clone(),
            background: pair.background_color.clone(),
        });
    Label {
        account_id: account_id.to_owned(),
        id: label.id.clone(),
        name: label.name.clone(),
        kind: label.kind.clone(),
        color: color,
        message_count: label.message_count,
    }
}
