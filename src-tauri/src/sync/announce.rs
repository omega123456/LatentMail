use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailChanged {
    pub account_id: String,
}

pub struct MailChangeAnnouncer<R: Runtime> {
    app: AppHandle<R>,
    change: MailChanged,
}

impl<R: Runtime> MailChangeAnnouncer<R> {
    pub fn new(app: &AppHandle<R>, account_id: &str) -> Self {
        Self {
            app: app.clone(),
            change: MailChanged {
                account_id: account_id.to_owned(),
            },
        }
    }

    pub fn announce<T>(self, outcome: Result<T, String>) -> Result<T, String> {
        if let Err(error) = self.app.emit(crate::events::MAIL_CHANGED, self.change) {
            tracing::warn!(target: "sync", "mail change announcement failed: {error}");
        }
        outcome
    }
}
