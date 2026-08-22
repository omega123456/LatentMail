pub mod bimi;
pub mod cache;
pub mod image;
pub mod profile;
pub mod resolver;

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use cache::{hash_key, AvatarCache, CacheAnswer, CacheDomain};
use resolver::Scheduler;

use crate::{
    settings::SettingsService,
    storage::{AccountRepository, Storage},
};

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AvatarPipeline {
    Sender,
    Account,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarResolvedEvent {
    pub pipeline: AvatarPipeline,
    pub key: String,
    pub resolved: bool,
}

pub trait AvatarEmitter: Send + Sync + 'static {
    fn emit_resolved(&self, event: AvatarResolvedEvent);
}

impl<R: Runtime> AvatarEmitter for AppHandle<R> {
    fn emit_resolved(&self, event: AvatarResolvedEvent) {
        let _ = self.emit("avatar://resolved", event);
    }
}

#[derive(Clone)]
pub struct AvatarService {
    cache: AvatarCache,
    scheduler: Arc<Scheduler>,
    storage: Storage,
    settings: SettingsService,
}

impl AvatarService {
    pub fn new(cache: AvatarCache, storage: Storage, settings: SettingsService) -> Self {
        Self {
            cache,
            scheduler: Arc::new(Scheduler::new()),
            storage,
            settings,
        }
    }

    pub async fn read_sender_avatar(
        &self,
        app: Arc<dyn AvatarEmitter>,
        domain: String,
    ) -> Result<Option<String>, String> {
        let domain = domain.trim().to_ascii_lowercase();
        if domain.is_empty() {
            return Ok(None);
        }
        let settings = self
            .settings
            .read()
            .await
            .map_err(|error| error.to_string())?;
        if !settings.show_sender_avatars {
            return Ok(None);
        }
        let cache_key = hash_key(&domain);
        match self.cache.answer(&cache_key, CacheDomain::Sender).await {
            CacheAnswer::Fresh(path) => Ok(path.map(path_to_string)),
            CacheAnswer::Stale => {
                self.schedule_sender_resolution(app, domain, cache_key);
                Ok(None)
            }
        }
    }

    fn schedule_sender_resolution(
        &self,
        app: Arc<dyn AvatarEmitter>,
        domain: String,
        cache_key: String,
    ) {
        let cache = self.cache.clone();
        let scheduler = Arc::clone(&self.scheduler);
        tokio::spawn(async move {
            let _key_guard = scheduler.key_guard(&cache_key).await;

            if matches!(
                cache.answer(&cache_key, CacheDomain::Sender).await,
                CacheAnswer::Fresh(_)
            ) {
                return;
            }
            let _permit = scheduler.acquire_permit().await;
            let resolved = match bimi::resolve_logo(&cache, &domain).await {
                Some(png) => cache
                    .store_hit(&cache_key, CacheDomain::Sender, &png)
                    .await
                    .is_ok(),
                None => {
                    let _ = cache.store_miss(&cache_key).await;
                    false
                }
            };
            app.emit_resolved(AvatarResolvedEvent {
                pipeline: AvatarPipeline::Sender,
                key: domain,
                resolved,
            });
        });
    }

    pub async fn read_account_avatar(
        &self,
        app: Arc<dyn AvatarEmitter>,
        account_id: String,
    ) -> Result<Option<String>, String> {
        let account_id = account_id.trim().to_owned();
        if account_id.is_empty() {
            return Ok(None);
        }
        let cache_key = hash_key(&account_id);
        match self.cache.answer(&cache_key, CacheDomain::Account).await {
            CacheAnswer::Fresh(path) => Ok(path.map(path_to_string)),
            CacheAnswer::Stale => {
                self.schedule_account_resolution(app, account_id, cache_key);
                Ok(None)
            }
        }
    }

    fn schedule_account_resolution(
        &self,
        app: Arc<dyn AvatarEmitter>,
        account_id: String,
        cache_key: String,
    ) {
        let cache = self.cache.clone();
        let scheduler = Arc::clone(&self.scheduler);
        let storage = self.storage.clone();
        tokio::spawn(async move {
            let _key_guard = scheduler.key_guard(&cache_key).await;
            if matches!(
                cache.answer(&cache_key, CacheDomain::Account).await,
                CacheAnswer::Fresh(_)
            ) {
                return;
            }
            let _permit = scheduler.acquire_permit().await;
            let avatar_url = storage
                .run({
                    let account_id = account_id.clone();
                    move |connection| AccountRepository::get(connection, &account_id)
                })
                .await
                .ok()
                .flatten()
                .and_then(|account| account.avatar_url);
            let resolved = match avatar_url {
                Some(url) => match profile::acquire_photo(&url).await {
                    Some(png) => cache
                        .store_hit(&cache_key, CacheDomain::Account, &png)
                        .await
                        .is_ok(),
                    None => {
                        let _ = cache.store_miss(&cache_key).await;
                        false
                    }
                },
                None => {
                    let _ = cache.store_miss(&cache_key).await;
                    false
                }
            };
            app.emit_resolved(AvatarResolvedEvent {
                pipeline: AvatarPipeline::Account,
                key: account_id,
                resolved,
            });
        });
    }
}

fn path_to_string(path: std::path::PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>, storage: Storage) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let cache = AvatarCache::new(storage.clone(), directory.join("avatar-cache"))?;
    let settings = app.state::<SettingsService>().inner().clone();
    app.manage(AvatarService::new(cache, storage, settings));
    Ok(())
}

#[tauri::command]
pub async fn read_sender_avatar<R: Runtime>(
    app: AppHandle<R>,
    service: tauri::State<'_, AvatarService>,
    domain: String,
) -> Result<Option<String>, String> {
    service
        .read_sender_avatar(Arc::new(app) as Arc<dyn AvatarEmitter>, domain)
        .await
}

#[tauri::command]
pub async fn read_account_avatar<R: Runtime>(
    app: AppHandle<R>,
    service: tauri::State<'_, AvatarService>,
    account_id: String,
) -> Result<Option<String>, String> {
    service
        .read_account_avatar(Arc::new(app) as Arc<dyn AvatarEmitter>, account_id)
        .await
}
