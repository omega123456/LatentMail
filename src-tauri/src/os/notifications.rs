#[cfg(feature = "test-utils")]
use std::collections::HashSet;
use std::{collections::HashMap, sync::Arc};

use chrono::Duration;
#[cfg(not(feature = "test-utils"))]
use tauri::Emitter;
use tauri::{AppHandle, Listener, Manager, Runtime};
use tokio::sync::Mutex;

use crate::sync::{MailArrival, NewMailEvent};

#[cfg(not(feature = "test-utils"))]
const ACCOUNT_ID: &str = "accountId";
#[cfg(not(feature = "test-utils"))]
const THREAD_ID: &str = "threadId";

pub struct NotificationController {
    pending: Arc<Mutex<HashMap<String, Vec<MailArrival>>>>,
    #[cfg(feature = "test-utils")]
    records: Arc<Mutex<Vec<NotificationRecord>>>,
    #[cfg(feature = "test-utils")]
    timers: Arc<Mutex<HashSet<String>>>,
}

#[cfg(feature = "test-utils")]
#[derive(Clone, Debug)]
pub struct NotificationRecord {
    pub account_id: String,
    pub arrivals: Vec<MailArrival>,
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if app.try_state::<NotificationController>().is_none() {
        app.manage(NotificationController {
            pending: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(feature = "test-utils")]
            records: Arc::new(Mutex::new(Vec::new())),
            #[cfg(feature = "test-utils")]
            timers: Arc::new(Mutex::new(HashSet::new())),
        });
    }
    #[cfg(not(feature = "test-utils"))]
    register_click_handler(app)?;
    let handle = app.clone();
    app.listen("mail://new", move |event| {
        let Ok(event) = serde_json::from_str::<NewMailEvent>(event.payload()) else {
            return;
        };
        if event.arrivals.is_empty() {
            return;
        }
        enqueue(&handle, event);
    });
    Ok(())
}

fn enqueue<R: Runtime>(app: &AppHandle<R>, event: NewMailEvent) {
    let app = app.clone();
    #[cfg(feature = "test-utils")]
    tokio::spawn(enqueue_arrivals(app, event));
    #[cfg(not(feature = "test-utils"))]
    tauri::async_runtime::spawn(enqueue_arrivals(app, event));
}

async fn enqueue_arrivals<R: Runtime>(app: AppHandle<R>, event: NewMailEvent) {
    let account_id = event.account_id;
    let first = app
        .state::<NotificationController>()
        .queue(account_id.clone(), event.arrivals)
        .await;
    if !first {
        return;
    }
    #[cfg(feature = "test-utils")]
    app.state::<NotificationController>()
        .timers
        .lock()
        .await
        .insert(account_id.clone());
    let Ok(delay) = Duration::seconds(3).to_std() else {
        return;
    };
    tokio::time::sleep(delay).await;
    NotificationController::flush(&app, account_id).await;
}

impl NotificationController {
    pub async fn queue(&self, account_id: String, arrivals: Vec<MailArrival>) -> bool {
        let mut groups = self.pending.lock().await;
        let first = !groups.contains_key(&account_id);
        groups.entry(account_id).or_default().extend(arrivals);
        first
    }

    pub async fn flush<R: Runtime>(app: &AppHandle<R>, account_id: String) {
        let arrivals = app
            .state::<NotificationController>()
            .pending
            .lock()
            .await
            .remove(&account_id)
            .unwrap_or_default();
        if arrivals.is_empty() {
            return;
        }
        if app
            .state::<crate::settings::SettingsService>()
            .read()
            .await
            .is_ok_and(|settings| settings.desktop_notifications)
        {
            show(app, &account_id, &arrivals).await;
        }
    }
}

pub fn content(arrivals: &[MailArrival]) -> Option<(String, String)> {
    let (first, rest) = arrivals.split_first()?;
    let subject = if first.subject.is_empty() {
        "(No subject)".to_owned()
    } else {
        first.subject.clone()
    };
    Some((
        first.sender.clone(),
        if rest.is_empty() {
            subject
        } else {
            format!("{subject} — and {} more", rest.len())
        },
    ))
}

pub fn click_intent(account_id: String, thread_id: Option<String>) -> serde_json::Value {
    match thread_id {
        Some(thread_id) => {
            serde_json::json!({ "kind": "openThread", "accountId": account_id, "threadId": thread_id })
        }
        None => serde_json::json!({ "kind": "openFolder", "accountId": account_id }),
    }
}

#[cfg(feature = "test-utils")]
impl NotificationController {
    pub async fn records(&self) -> Vec<NotificationRecord> {
        self.records.lock().await.clone()
    }

    pub async fn pending_count(&self, account_id: &str) -> usize {
        self.pending
            .lock()
            .await
            .get(account_id)
            .map_or(0, Vec::len)
    }

    pub async fn fire_batch_timer<R: Runtime>(app: &AppHandle<R>, account_id: String) {
        if app
            .state::<NotificationController>()
            .timers
            .lock()
            .await
            .remove(&account_id)
        {
            Self::flush(app, account_id).await;
        }
    }

    pub async fn record(&self, account_id: String, arrivals: Vec<MailArrival>) {
        self.records.lock().await.push(NotificationRecord {
            account_id,
            arrivals,
        });
    }

    pub fn click<R: Runtime>(app: &AppHandle<R>, account_id: String, thread_id: Option<String>) {
        crate::os::window::show_and_focus(app);
        let _ = tauri::Emitter::emit(app, "os://intent", click_intent(account_id, thread_id));
    }
}

#[cfg(not(feature = "test-utils"))]
static MANAGER: std::sync::OnceLock<Arc<dyn user_notify::NotificationManager>> =
    std::sync::OnceLock::new();

#[cfg(not(feature = "test-utils"))]
fn manager() -> &'static Arc<dyn user_notify::NotificationManager> {
    MANAGER.get_or_init(|| {
        user_notify::get_notification_manager("com.latentmail.desktop".to_owned(), None)
    })
}

#[cfg(not(feature = "test-utils"))]
fn register_click_handler<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use user_notify::NotificationResponseAction;

    let handle = app.clone();
    manager()
        .register(
            Box::new(move |response| {
                if response.action != NotificationResponseAction::Default {
                    return;
                }
                crate::os::window::show_and_focus(&handle);
                let Some(account_id) = response.user_info.get(ACCOUNT_ID).cloned() else {
                    return;
                };
                let intent = click_intent(account_id, response.user_info.get(THREAD_ID).cloned());
                let _ = handle.emit("os://intent", intent);
            }),
            Vec::new(),
        )
        .map_err(|error| error.to_string())
}

#[cfg(not(feature = "test-utils"))]
async fn show<R: Runtime>(_: &AppHandle<R>, account_id: &str, arrivals: &[MailArrival]) {
    use user_notify::NotificationBuilder;

    let Some((title, body)) = content(arrivals) else {
        return;
    };
    let first = &arrivals[0];
    let mut info = HashMap::from([(ACCOUNT_ID.to_owned(), account_id.to_owned())]);
    if arrivals.len() == 1 {
        info.insert(THREAD_ID.to_owned(), first.thread_id.clone());
    }
    let manager = manager();
    if manager
        .get_notification_permission_state()
        .await
        .is_ok_and(|granted| granted)
        || manager
            .first_time_ask_for_notification_permission()
            .await
            .is_ok_and(|granted| granted)
    {
        let _ = manager
            .send_notification(
                NotificationBuilder::new()
                    .title(&title)
                    .body(&body)
                    .set_user_info(info),
            )
            .await;
    }
}

#[cfg(feature = "test-utils")]
async fn show<R: Runtime>(app: &AppHandle<R>, account_id: &str, arrivals: &[MailArrival]) {
    app.state::<NotificationController>()
        .record(account_id.to_owned(), arrivals.to_vec())
        .await;
}
