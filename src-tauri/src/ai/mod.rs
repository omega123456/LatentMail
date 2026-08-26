pub mod chat;
pub mod chunker;
pub mod commands;
pub mod credentials;
pub mod index;
pub mod prompts;
pub mod provider;
pub mod retrieval;

use crate::storage::{AccountAiConfigRepository, AccountRepository, Storage};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[derive(Clone)]
pub struct AiService {
    storage: Storage,
    removing: Arc<Mutex<HashSet<String>>>,
    reconfiguring: Arc<Mutex<HashSet<String>>>,
    index_errors: Arc<Mutex<HashMap<String, String>>>,
    index_states: Arc<Mutex<HashMap<String, IndexState>>>,
    chat: chat::ChatRegistry,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexState {
    NotStarted,
    Preparing,
    Building,
    Complete,
    Partial,
    Paused,
    Interrupted,
    Unavailable,
    NeedsRebuild,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigDto {
    pub account_id: String,
    pub email: String,
    pub display_name: String,
    pub enabled: bool,
    pub base_url: Option<String>,
    pub chat_model: Option<String>,
    pub embedding_model: Option<String>,
    pub embedding_dimensions: Option<i64>,
    pub has_api_key: bool,
    pub index_paused: bool,
}

impl AiService {
    pub fn new(storage: Storage) -> Self {
        Self {
            storage,
            removing: Arc::default(),
            reconfiguring: Arc::default(),
            index_errors: Arc::default(),
            index_states: Arc::default(),
            chat: chat::ChatRegistry::default(),
        }
    }
    pub fn chat(&self) -> &chat::ChatRegistry {
        &self.chat
    }
    pub async fn chat_ready(&self, account_id: &str) -> Result<(), String> {
        let config = self.config_for(account_id).await?;
        if !config.enabled {
            return Err("AI is turned off for this account".to_owned());
        }
        if config.base_url.is_none() {
            return Err("Save an API root first".to_owned());
        }
        if config.chat_model.is_none() {
            return Err("Select a chat model first".to_owned());
        }
        if self.needs_rebuild(account_id).await? {
            return Err("The index must be rebuilt".to_owned());
        }
        let state = index::status(self, account_id.to_owned()).await?.state;
        if !matches!(state, IndexState::Complete | IndexState::Partial) {
            return Err("The index is not ready yet".to_owned());
        }
        Ok(())
    }
    pub async fn configs(&self) -> Result<Vec<AiConfigDto>, String> {
        let rows = self
            .storage
            .run(|connection| {
                let configs = AccountAiConfigRepository::list(connection)?;
                let lookup: HashMap<_, _> = configs
                    .into_iter()
                    .map(|config| (config.account_id.clone(), config))
                    .collect();
                Ok(AccountRepository::list(connection)?
                    .into_iter()
                    .map(|account| {
                        let config = lookup.get(&account.id);
                        AiConfigDto {
                            has_api_key: credentials::load(&account.id).unwrap_or(None).is_some(),
                            account_id: account.id.clone(),
                            email: account.email,
                            display_name: account.display_name,
                            enabled: config.is_some_and(|value| value.enabled),
                            base_url: config.and_then(|value| value.base_url.clone()),
                            chat_model: config.and_then(|value| value.chat_model.clone()),
                            embedding_model: config.and_then(|value| value.embedding_model.clone()),
                            embedding_dimensions: config
                                .and_then(|value| value.embedding_dimensions),
                            index_paused: config.is_some_and(|value| value.index_paused),
                        }
                    })
                    .collect::<Vec<_>>())
            })
            .await
            .map_err(|error| error.to_string())?;
        Ok(rows)
    }
    pub async fn config_for(
        &self,
        account_id: &str,
    ) -> Result<crate::storage::AccountAiConfig, String> {
        let id = account_id.to_owned();
        self.storage
            .run(move |connection| {
                AccountAiConfigRepository::get(connection, &id)?
                    .ok_or(rusqlite::Error::QueryReturnedNoRows)
            })
            .await
            .map_err(|error| error.to_string())
    }
    pub async fn require_account(&self, account_id: &str) -> Result<(), String> {
        let account_id = account_id.to_owned();
        self.storage
            .run(move |connection| AccountRepository::get(connection, &account_id))
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Account does not exist".to_owned())
            .map(|_| ())
    }
    pub async fn set_enabled<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        account_id: String,
        enabled: bool,
    ) -> Result<(), String> {
        let id = account_id.clone();
        self.storage
            .run(move |connection| AccountAiConfigRepository::set_enabled(connection, &id, enabled))
            .await
            .map_err(|error| error.to_string())?;
        if enabled {
            self.clear_index_state(&account_id)?;
        } else {
            self.clear_index_error(&account_id)?;
            self.set_index_state(&account_id, IndexState::Unavailable)?;
        }
        app.emit("ai://config", serde_json::json!({"accountId":account_id}))
            .map_err(|error| error.to_string())
    }
    pub async fn set_base_url<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        account_id: String,
        base_url: String,
    ) -> Result<(), String> {
        let root = provider::api_root(&base_url)?.to_string();
        let id = account_id.clone();
        let stored = root.clone();
        self.storage
            .run(move |connection| {
                AccountAiConfigRepository::set_base_url(connection, &id, &stored)
            })
            .await
            .map_err(|error| error.to_string())?;
        app.emit("ai://config", serde_json::json!({"accountId":account_id}))
            .map_err(|error| error.to_string())
    }
    pub async fn set_chat_model<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        account_id: String,
        model: Option<String>,
    ) -> Result<(), String> {
        let id = account_id.clone();
        self.storage
            .run(move |connection| {
                AccountAiConfigRepository::set_chat_model(connection, &id, model.as_deref())
            })
            .await
            .map_err(|error| error.to_string())?;
        app.emit("ai://config", serde_json::json!({"accountId":account_id}))
            .map_err(|error| error.to_string())
    }
    pub async fn set_embedding_model<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        account_id: String,
        model: String,
        dimensions: i64,
    ) -> Result<(), String> {
        let id = account_id.clone();
        self.storage
            .run(move |connection| {
                let transaction = connection.unchecked_transaction()?;
                crate::storage::EmbeddingRepository::drop(&transaction, &id)?;
                crate::storage::EmbeddingRepository::create(&transaction, &id, dimensions)?;
                AccountAiConfigRepository::set_embedding_model(
                    &transaction,
                    &id,
                    &model,
                    dimensions,
                )?;
                AccountAiConfigRepository::set_index_paused(&transaction, &id, false)?;
                transaction.commit()
            })
            .await
            .map_err(|error| error.to_string())?;
        app.emit("ai://config", serde_json::json!({"accountId":account_id}))
            .map_err(|error| error.to_string())
    }
    pub fn storage(&self) -> Storage {
        self.storage.clone()
    }
    pub fn begin_removal(&self, account_id: &str) -> Result<(), String> {
        self.removing
            .lock()
            .map_err(|_| "AI removal lock poisoned".to_owned())?
            .insert(account_id.to_owned());
        Ok(())
    }
    pub fn is_removing(&self, account_id: &str) -> Result<bool, String> {
        Ok(self
            .removing
            .lock()
            .map_err(|_| "AI removal lock poisoned".to_owned())?
            .contains(account_id))
    }
    pub fn begin_reconfiguration(&self, account_id: &str) -> Result<(), String> {
        self.reconfiguring
            .lock()
            .map_err(|_| "AI reconfiguration lock poisoned".to_owned())?
            .insert(account_id.to_owned());
        Ok(())
    }
    pub fn finish_reconfiguration(&self, account_id: &str) -> Result<(), String> {
        self.reconfiguring
            .lock()
            .map_err(|_| "AI reconfiguration lock poisoned".to_owned())?
            .remove(account_id);
        Ok(())
    }
    pub fn is_reconfiguring(&self, account_id: &str) -> Result<bool, String> {
        Ok(self
            .reconfiguring
            .lock()
            .map_err(|_| "AI reconfiguration lock poisoned".to_owned())?
            .contains(account_id))
    }
    pub fn index_error(&self, account_id: &str) -> Result<Option<String>, String> {
        Ok(self
            .index_errors
            .lock()
            .map_err(|_| "AI index error lock poisoned".to_owned())?
            .get(account_id)
            .cloned())
    }
    pub fn set_index_error(&self, account_id: &str, error: String) -> Result<(), String> {
        self.index_errors
            .lock()
            .map_err(|_| "AI index error lock poisoned".to_owned())?
            .insert(account_id.to_owned(), error);
        self.set_index_state(account_id, IndexState::Interrupted)?;
        Ok(())
    }
    pub fn clear_index_error(&self, account_id: &str) -> Result<(), String> {
        self.index_errors
            .lock()
            .map_err(|_| "AI index error lock poisoned")?
            .remove(account_id);
        Ok(())
    }
    pub fn index_state(&self, account_id: &str) -> Result<Option<IndexState>, String> {
        Ok(self
            .index_states
            .lock()
            .map_err(|_| "AI index state lock poisoned".to_owned())?
            .get(account_id)
            .copied())
    }
    pub fn set_index_state(&self, account_id: &str, state: IndexState) -> Result<(), String> {
        self.index_states
            .lock()
            .map_err(|_| "AI index state lock poisoned".to_owned())?
            .insert(account_id.to_owned(), state);
        Ok(())
    }
    pub fn clear_index_state(&self, account_id: &str) -> Result<(), String> {
        self.index_states
            .lock()
            .map_err(|_| "AI index state lock poisoned".to_owned())?
            .remove(account_id);
        Ok(())
    }
    pub async fn index_ready(&self, account_id: &str) -> Result<bool, String> {
        if self.is_removing(account_id)? || self.is_reconfiguring(account_id)? {
            return Ok(false);
        }
        let config = self.config_for(account_id).await?;
        if self.needs_rebuild(account_id).await? {
            return Ok(false);
        }
        Ok(config.enabled
            && !config.index_paused
            && config.base_url.is_some()
            && config.embedding_model.is_some()
            && config.embedding_dimensions.is_some())
    }
    pub async fn needs_rebuild(&self, account_id: &str) -> Result<bool, String> {
        let id = account_id.to_owned();
        self.storage
            .run(move |connection| {
                crate::storage::EmbeddingRepository::needs_rebuild(connection, &id)
            })
            .await
            .map_err(|error| error.to_string())
    }
}
pub fn initialize<R: Runtime>(app: &AppHandle<R>, storage: Storage) -> Result<(), String> {
    let connection = storage.connection().map_err(|error| error.to_string())?;
    for config in AccountAiConfigRepository::list(&connection).map_err(|error| error.to_string())? {
        if let Some(dimensions) = config.embedding_dimensions {
            crate::storage::EmbeddingRepository::create(
                &connection,
                &config.account_id,
                dimensions,
            )
            .map_err(|error| error.to_string())?;
        }
    }
    app.manage(AiService::new(storage));
    Ok(())
}
