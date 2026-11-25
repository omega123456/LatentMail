use serde::Deserialize;
use tauri::Runtime;

use crate::sync::{announce::MailChangeAnnouncer, LabelDto};
use crate::{
    gmail::labels::resolve_color,
    ipc::AppServices,
    storage::{LabelColor, LabelKey, LabelNameCheck, LabelRepository, Storage, ThreadRepository},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLabelRequest {
    pub account_id: String,
    pub name: String,
    pub color_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameLabelRequest {
    pub account_id: String,
    pub label_id: String,
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecolorLabelRequest {
    pub account_id: String,
    pub label_id: String,
    pub color_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLabelRequest {
    pub account_id: String,
    pub label_id: String,
}

pub(super) async fn run_list_labels(
    storage: &Storage,
    account_id: String,
) -> Result<Vec<LabelDto>, String> {
    let (labels, unread_counts) = string_try!(
        storage
            .run(move |connection| Ok((
                LabelRepository::list(connection, &account_id)?,
                LabelRepository::unread_thread_counts(connection, &account_id)?
            )))
            .await
    );
    Ok(labels
        .into_iter()
        .map(|label| {
            let unread_count = unread_counts.get(&label.id).copied().unwrap_or_default();
            LabelDto::new(label, unread_count)
        })
        .collect())
}

fn resolve_color_or_error(color_id: Option<&str>) -> Result<Option<LabelColor>, String> {
    match color_id {
        None => Ok(None),
        Some(id) => resolve_color(id)
            .map(|pair| {
                Some(LabelColor {
                    text: pair.text_color,
                    background: pair.background_color,
                })
            })
            .ok_or_else(|| format!("'{id}' is not a recognised label colour")),
    }
}

pub(super) async fn read_label_dto(
    storage: &Storage,
    account_id: String,
    label_id: String,
) -> Result<Option<LabelDto>, String> {
    storage
        .run(move |connection| {
            let unread_counts = LabelRepository::unread_thread_counts(connection, &account_id)?;
            Ok(
                LabelRepository::get(connection, &account_id, &label_id)?.map(|label| {
                    let unread_count = unread_counts.get(&label.id).copied().unwrap_or_default();
                    LabelDto::new(label, unread_count)
                }),
            )
        })
        .await
        .map_err(|error| error.to_string())
}

pub(super) async fn apply_create_label<R: Runtime>(
    services: &AppServices<'_, R>,
    request: CreateLabelRequest,
) -> Result<LabelDto, String> {
    let storage = services.storage()?;
    let color = resolve_color_or_error(request.color_id.as_deref())?;
    let account = request.account_id.clone();
    let trimmed = storage
        .run(move |connection| {
            Ok(LabelRepository::validate_name(
                connection,
                LabelNameCheck {
                    account_id: &account,
                    name: &request.name,
                    exclude_id: None,
                },
            ))
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    let client = services.gmail_client(&request.account_id).await?;
    let gmail_color = color.as_ref().map(|color| crate::gmail::LabelColorPair {
        text_color: color.text.clone(),
        background_color: color.background.clone(),
    });
    let created = client
        .create_label(&trimmed, gmail_color.as_ref())
        .await
        .map_err(|error| error.to_string())?;

    let stored = crate::sync::to_label(&request.account_id, &created);
    storage
        .run(move |connection| LabelRepository::upsert(connection, &stored))
        .await
        .map_err(|error| error.to_string())?;
    read_label_dto(storage.inner(), request.account_id, created.id)
        .await?
        .ok_or_else(|| "label vanished immediately after creation".to_owned())
}

pub(super) async fn run_create_label<R: Runtime>(
    services: AppServices<'_, R>,
    request: CreateLabelRequest,
) -> Result<LabelDto, String> {
    let announcer = MailChangeAnnouncer::new(services.app(), &request.account_id);
    let outcome = apply_create_label(&services, request).await;
    announcer.announce(outcome)
}

pub(super) async fn apply_rename_label<R: Runtime>(
    services: &AppServices<'_, R>,
    request: RenameLabelRequest,
) -> Result<LabelDto, String> {
    let storage = services.storage()?;
    let (account_for_validate, id_for_validate) =
        (request.account_id.clone(), request.label_id.clone());
    let trimmed = storage
        .run(move |connection| {
            Ok(LabelRepository::validate_name(
                connection,
                LabelNameCheck {
                    account_id: &account_for_validate,
                    name: &request.name,
                    exclude_id: Some(&id_for_validate),
                },
            ))
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    let client = services.gmail_client(&request.account_id).await?;
    client
        .update_label(
            &request.label_id,
            crate::gmail::labels::LabelUpdate {
                name: Some(&trimmed),
                color: None,
            },
        )
        .await
        .map_err(|error| error.to_string())?;

    let (account, id, new_name) = (
        request.account_id.clone(),
        request.label_id.clone(),
        trimmed,
    );
    storage
        .run(move |connection| {
            LabelRepository::rename(
                connection,
                LabelKey {
                    account_id: &account,
                    id: &id,
                },
                &new_name,
            )
        })
        .await
        .map_err(|error| error.to_string())?;
    read_label_dto(storage.inner(), request.account_id, request.label_id)
        .await?
        .ok_or_else(|| "label not found".to_owned())
}

pub(super) async fn run_rename_label<R: Runtime>(
    services: AppServices<'_, R>,
    request: RenameLabelRequest,
) -> Result<LabelDto, String> {
    let announcer = MailChangeAnnouncer::new(services.app(), &request.account_id);
    let outcome = apply_rename_label(&services, request).await;
    announcer.announce(outcome)
}

pub(super) async fn apply_recolor_label<R: Runtime>(
    services: &AppServices<'_, R>,
    request: RecolorLabelRequest,
) -> Result<LabelDto, String> {
    let storage = services.storage()?;
    let color = resolve_color(&request.color_id)
        .map(|pair| LabelColor {
            text: pair.text_color,
            background: pair.background_color,
        })
        .ok_or_else(|| format!("'{}' is not a recognised label colour", request.color_id))?;

    let client = services.gmail_client(&request.account_id).await?;
    let gmail_color = crate::gmail::LabelColorPair {
        text_color: color.text.clone(),
        background_color: color.background.clone(),
    };
    client
        .update_label(
            &request.label_id,
            crate::gmail::labels::LabelUpdate {
                name: None,
                color: Some(&gmail_color),
            },
        )
        .await
        .map_err(|error| error.to_string())?;

    let (account, id, stored_color) = (request.account_id.clone(), request.label_id.clone(), color);
    storage
        .run(move |connection| {
            LabelRepository::set_color(
                connection,
                LabelKey {
                    account_id: &account,
                    id: &id,
                },
                Some(&stored_color),
            )
        })
        .await
        .map_err(|error| error.to_string())?;
    read_label_dto(storage.inner(), request.account_id, request.label_id)
        .await?
        .ok_or_else(|| "label not found".to_owned())
}

pub(super) async fn run_recolor_label<R: Runtime>(
    services: AppServices<'_, R>,
    request: RecolorLabelRequest,
) -> Result<LabelDto, String> {
    let announcer = MailChangeAnnouncer::new(services.app(), &request.account_id);
    let outcome = apply_recolor_label(&services, request).await;
    announcer.announce(outcome)
}

pub(super) async fn apply_delete_label<R: Runtime>(
    services: &AppServices<'_, R>,
    request: DeleteLabelRequest,
) -> Result<(), String> {
    let storage = services.storage()?;
    let client = services.gmail_client(&request.account_id).await?;
    client
        .delete_label(&request.label_id)
        .await
        .map_err(|error| error.to_string())?;
    storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let touched: std::collections::HashSet<String> = LabelRepository::threads_with_label(
                &transaction,
                &request.account_id,
                &request.label_id,
            )?
            .into_iter()
            .collect();
            LabelRepository::delete(&transaction, &request.account_id, &request.label_id)?;
            ThreadRepository::recompute_many(&transaction, &request.account_id, &touched)?;
            transaction.commit()
        })
        .await
        .map_err(|error| error.to_string())
}

pub(super) async fn run_delete_label<R: Runtime>(
    services: AppServices<'_, R>,
    request: DeleteLabelRequest,
) -> Result<(), String> {
    let announcer = MailChangeAnnouncer::new(services.app(), &request.account_id);
    let outcome = apply_delete_label(&services, request).await;
    announcer.announce(outcome)
}
