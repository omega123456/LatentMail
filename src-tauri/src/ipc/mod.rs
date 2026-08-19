use crate::queue::{QueueEngine, QueueSummary};
use tauri::{AppHandle, Emitter, Runtime, Url};
#[cfg(not(feature = "test-utils"))]
use tauri_plugin_opener::OpenerExt;

#[derive(serde::Serialize)]
pub struct HealthCheck {
    status: &'static str,
}

pub fn health_response() -> HealthCheck {
    HealthCheck { status: "ok" }
}

#[tauri::command]
pub fn health_check<R: Runtime>(app: AppHandle<R>) -> Result<HealthCheck, String> {
    let result = health_response();
    if let Err(error) = app.emit("system://health", &result) {
        return Err(error.to_string());
    }
    Ok(result)
}

#[tauri::command]
pub fn open_external_url<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?;
    open_url(app, url)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrontendLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}


#[tauri::command]
pub fn write_frontend_log(level: FrontendLogLevel, message: String) {
    match level {
        FrontendLogLevel::Debug => tracing::debug!(target: "frontend", "{}", message),
        FrontendLogLevel::Info => tracing::info!(target: "frontend", "{}", message),
        FrontendLogLevel::Warn => tracing::warn!(target: "frontend", "{}", message),
        FrontendLogLevel::Error => tracing::error!(target: "frontend", "{}", message),
    }
}

#[tauri::command]
pub fn pause_queue<R: Runtime>(
    app: AppHandle<R>,
    queue: tauri::State<'_, std::sync::Arc<QueueEngine>>,
) -> Result<QueueSummary, String> {
    queue.pause();
    let summary = queue.summary();
    app.emit("queue://summary", &summary)
        .map_err(|error| error.to_string())?;
    Ok(summary)
}

#[tauri::command]
pub fn resume_queue<R: Runtime>(
    app: AppHandle<R>,
    queue: tauri::State<'_, std::sync::Arc<QueueEngine>>,
) -> Result<QueueSummary, String> {
    queue.resume();
    let summary = queue.summary();
    app.emit("queue://summary", &summary)
        .map_err(|error| error.to_string())?;
    Ok(summary)
}

#[tauri::command]
pub fn read_queue_summary(queue: tauri::State<'_, std::sync::Arc<QueueEngine>>) -> QueueSummary {
    queue.summary()
}

#[cfg(not(feature = "test-utils"))]
fn open_url<R: Runtime>(app: AppHandle<R>, url: Url) -> Result<(), String> {
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(feature = "test-utils")]
fn open_url<R: Runtime>(_app: AppHandle<R>, _url: Url) -> Result<(), String> {
    Err("System-browser access is disabled in tests".to_owned())
}

pub fn validate_external_url(url: &str) -> Result<Url, String> {
    let url = Url::parse(url).map_err(|_| "URL must be absolute".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only HTTP(S) URLs may be opened".to_owned());
    }

    Ok(url)
}

pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        health_check,
        open_external_url,
        write_frontend_log,
        pause_queue,
        resume_queue,
        read_queue_summary,
        crate::auth::list_accounts,
        crate::auth::begin_sign_in,
        crate::auth::begin_reauthentication,
        crate::auth::remove_account,
        crate::settings::read_settings,
        crate::settings::write_setting,
        crate::logging::read_log_entries,
        crate::sync::commands::list_labels,
        crate::sync::commands::lookup_contacts,
        crate::sync::commands::reply_context,
        crate::sync::commands::stage_attachment_from_path,
        crate::sync::commands::stage_attachment_from_bytes,
        crate::sync::commands::release_staged_attachment,
        crate::sync::commands::save_compose_draft,
        crate::sync::commands::send_compose_draft,
        crate::sync::commands::discard_compose_draft,
        crate::sync::commands::hydrate_compose_draft,
        crate::sync::commands::list_threads,
        crate::sync::commands::load_conversation,
        crate::sync::commands::fetch_message_body,
        crate::sync::commands::trigger_sync,
        crate::sync::commands::read_sync_status,
        crate::sync::commands::star_thread,
        crate::sync::commands::unstar_thread,
        crate::sync::commands::mark_thread_read,
        crate::sync::commands::mark_thread_unread,
        crate::sync::commands::mutate_threads,
        crate::sync::commands::mutate_messages,
        crate::sync::triage::delete_threads,
        crate::sync::triage::move_threads,
        crate::sync::triage::delete_messages,
        crate::sync::triage::move_messages,
        crate::search::search_threads,
        crate::search::parse_search_query,
        crate::sync::commands::delete_draft,
        crate::sync::commands::create_label,
        crate::sync::commands::rename_label,
        crate::sync::commands::recolor_label,
        crate::sync::commands::delete_label,
        crate::sync::commands::read_traversal_status,
        crate::avatars::read_sender_avatar,
        crate::avatars::read_account_avatar,
        crate::queue::commands::read_queue_operations,
        crate::queue::commands::cancel_queue_operation,
        crate::queue::commands::retry_queue_operation,
        crate::queue::commands::retry_failed_operations,
        crate::queue::commands::clear_queue_history,
        crate::queue::commands::set_queue_paused,
        crate::attachments::commands::ensure_attachment_cached,
        crate::attachments::commands::read_attachment_bytes,
        crate::attachments::commands::read_attachment_text,
        crate::attachments::commands::save_attachment_to_path,
        crate::attachments::commands::stage_attachment_into_draft
    ])
}
