use std::sync::Arc;

use serde::{de::DeserializeOwned, Deserialize};
use tauri::{
    ipc::{CommandArg, CommandItem, InvokeBody, InvokeError},
    AppHandle, Manager, Runtime, State,
};

use crate::{
    ai::AiService,
    attachments::AttachmentCache,
    auth::AuthService,
    avatars::AvatarService,
    compose::{drafts::SaveCoalescer, staging::Staging},
    gmail::GmailClient,
    queue::QueueEngine,
    settings::SettingsService,
    storage::Storage,
    sync::{
        commands::{gmail_client_for, GmailClientDeps},
        SyncEngine,
    },
};

pub struct CommandPayload<T>(pub T);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdRequest {
    pub account_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountMessageRequest {
    pub account_id: String,
    pub message_id: String,
}

impl<'de, T: DeserializeOwned, R: Runtime> CommandArg<'de, R> for CommandPayload<T> {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let InvokeBody::Json(value) = command.message.payload() else {
            return Err(InvokeError::from(format!(
                "command {} expected a JSON payload",
                command.name
            )));
        };
        serde_json::from_value(value.clone())
            .map(Self)
            .map_err(|error| InvokeError::from(error.to_string()))
    }
}

pub struct AppServices<'a, R: Runtime> {
    app: &'a AppHandle<R>,
}

impl<'a, R: Runtime> AppServices<'a, R> {
    pub fn new(app: &'a AppHandle<R>) -> Self {
        Self { app: app }
    }

    pub fn app(&self) -> &'a AppHandle<R> {
        self.app
    }

    pub fn managed<T: Send + Sync + 'static>(&self) -> Result<State<'a, T>, String> {
        self.app
            .try_state::<T>()
            .ok_or_else(|| format!("{} is not managed", std::any::type_name::<T>()))
    }

    pub fn storage(&self) -> Result<State<'a, Storage>, String> {
        self.managed()
    }

    pub fn auth(&self) -> Result<State<'a, AuthService>, String> {
        self.managed()
    }

    pub fn sync(&self) -> Result<State<'a, Arc<SyncEngine>>, String> {
        self.managed()
    }

    pub fn queue(&self) -> Result<State<'a, Arc<QueueEngine>>, String> {
        self.managed()
    }

    pub fn ai(&self) -> Result<State<'a, AiService>, String> {
        self.managed()
    }

    pub fn avatars(&self) -> Result<State<'a, AvatarService>, String> {
        self.managed()
    }

    pub fn settings(&self) -> Result<State<'a, SettingsService>, String> {
        self.managed()
    }

    pub fn staging(&self) -> Result<State<'a, Arc<Staging>>, String> {
        self.managed()
    }

    pub fn coalescer(&self) -> Result<State<'a, Arc<SaveCoalescer>>, String> {
        self.managed()
    }

    pub fn attachment_cache(&self) -> Result<State<'a, AttachmentCache>, String> {
        self.managed()
    }

    pub async fn gmail_client(&self, account_id: &str) -> Result<GmailClient, String> {
        let auth = self.auth()?;
        let engine = self.sync()?;
        let deps = GmailClientDeps {
            app: self.app,
            auth: &auth,
            engine: &engine,
        };
        gmail_client_for(deps, account_id).await
    }
}

impl<'a, R: Runtime> CommandArg<'a, R> for AppServices<'a, R> {
    fn from_command(command: CommandItem<'a, R>) -> Result<Self, InvokeError> {
        Ok(Self::new(command.message.webview_ref().app_handle()))
    }
}
