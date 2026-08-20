use serde::Serialize;
use tauri::{AppHandle, Runtime};

#[cfg(not(feature = "test-utils"))]
use tauri_plugin_updater::UpdaterExt;

#[cfg(not(feature = "test-utils"))]
use crate::sync::to_millis;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSummaryDto {
    pub version: String,
    pub notes: Option<String>,
    pub date_millis: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckDto {
    pub current_version: String,
    pub available: Option<UpdateSummaryDto>,
}

#[cfg(not(feature = "test-utils"))]
#[tauri::command]
pub async fn check_for_update<R: Runtime>(app: AppHandle<R>) -> Result<UpdateCheckDto, String> {
    let current_version = app.package_info().version.to_string();
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let available = update.map(|update| UpdateSummaryDto {
        version: update.version,
        notes: update.body,
        date_millis: update.date.map(|date| to_millis(date.unix_timestamp())),
    });
    Ok(UpdateCheckDto {
        current_version,
        available,
    })
}

#[cfg(feature = "test-utils")]
#[tauri::command]
pub async fn check_for_update<R: Runtime>(app: AppHandle<R>) -> Result<UpdateCheckDto, String> {
    Ok(UpdateCheckDto {
        current_version: app.package_info().version.to_string(),
        available: None,
    })
}

#[cfg(not(feature = "test-utils"))]
#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "No update is available to install".to_owned())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    if !cfg!(windows) {
        app.restart();
    }
    Ok(())
}

#[cfg(feature = "test-utils")]
#[tauri::command]
pub async fn install_update<R: Runtime>(_app: AppHandle<R>) -> Result<(), String> {
    Err("Update installation is unsupported in this build".to_owned())
}
