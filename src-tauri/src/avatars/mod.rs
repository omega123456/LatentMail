//! Owns everything about acquiring, storing and serving identity imagery
//! (D4): the two commands the frontend calls, the resolution event it
//! listens for, and the shared cache both acquisition pipelines write
//! through. Deliberately outside the three-lane Gmail operation queue —
//! this module never calls Gmail and never touches [`crate::queue`].

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

/// Which pipeline produced a resolution — carried on the completion event
/// so the frontend's event-bridge listener invalidates the right query.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AvatarPipeline {
    Sender,
    Account,
}

/// The resolution-complete event payload (`avatar://resolved`): which
/// pipeline resolved, the raw domain (sender pipeline) or account id
/// (account pipeline) that was resolved, and whether an image resulted.
/// `key` must stay the raw, un-hashed value — the frontend's query keys
/// ([`queryKeys.senderAvatar`]/[`queryKeys.accountAvatar`] in
/// `src/lib/query/hooks.ts`) are keyed on the raw domain/account id, not on
/// [`cache::hash_key`]'s internal cache key, so the event-bridge listener
/// can invalidate the exact query that just resolved.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarResolvedEvent {
    pub pipeline: AvatarPipeline,
    pub key: String,
    pub resolved: bool,
}

/// Abstracts emitting the resolution event so `AvatarService`'s actual
/// resolution logic never needs to be generic over `Runtime` — only the
/// thin `#[tauri::command]` wrappers below, which receive a concrete
/// `AppHandle<R>`, are. Collapsing the generic surface this way keeps every
/// test binary that links this module from separately monomorphizing the
/// whole resolution pipeline (bounded concurrency, cache writes, the BIMI
/// and profile pipelines) once per `Runtime` it happens to use.
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

    /// Answers from cache immediately; schedules a background BIMI
    /// resolution on a miss unless `showSenderAvatars` is off. D14: the
    /// preference is enforced *here*, not only by the frontend declining to
    /// call this command — with it off, no lookup is ever scheduled.
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
            // A concurrent caller may have already resolved this domain
            // while this task waited for the guard (D4's collapsing) —
            // re-check before doing any network work.
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

    /// Answers from cache immediately; schedules a background account
    /// photograph acquisition on a miss. Not gated by `showSenderAvatars`
    /// (that preference only governs third-party sender lookups, per the
    /// plan) — the account photograph involves no third-party lookup.
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

/// Opens the avatar module's own storage handle and cache directory, and
/// manages [`AvatarService`]. Must run after `settings::initialize`, which
/// this reuses the already-managed [`SettingsService`] from, so
/// `showSenderAvatars` reads reflect whatever the running app has, not a
/// second, independent settings instance.
pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let storage =
        Storage::open(directory.join("latentmail.sqlite")).map_err(|error| error.to_string())?;
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
