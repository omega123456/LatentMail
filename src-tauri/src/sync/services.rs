use std::sync::Arc;

use tauri::{
    ipc::{CommandArg, CommandItem, InvokeError},
    AppHandle, Manager, Runtime, State,
};

use crate::{auth::AuthService, gmail::GmailClient, storage::Storage};

use super::{commands::gmail_client_for, SyncEngine};

pub fn managed<'a, T: Send + Sync + 'static, R: Runtime>(
    app: &'a AppHandle<R>,
) -> Result<State<'a, T>, String> {
    app.try_state::<T>()
        .ok_or_else(|| format!("{} is not managed", std::any::type_name::<T>()))
}

pub struct GmailServices<'a, R: Runtime> {
    pub app: AppHandle<R>,
    pub auth: State<'a, AuthService>,
    pub engine: State<'a, Arc<SyncEngine>>,
    pub storage: State<'a, Storage>,
}

impl<'a, R: Runtime> GmailServices<'a, R> {
    pub fn new(app: &'a AppHandle<R>) -> Result<Self, String> {
        Ok(Self {
            app: app.clone(),
            auth: managed(app)?,
            engine: managed(app)?,
            storage: managed(app)?,
        })
    }

    pub async fn client(&self, account_id: &str) -> Result<GmailClient, String> {
        gmail_client_for(&self.app, &self.auth, &self.engine, account_id).await
    }
}

impl<'a, R: Runtime> CommandArg<'a, R> for GmailServices<'a, R> {
    fn from_command(command: CommandItem<'a, R>) -> Result<Self, InvokeError> {
        Self::new(command.message.webview_ref().app_handle()).map_err(InvokeError::from)
    }
}
