use std::{path::PathBuf, sync::Arc, time::Duration};

use tauri::{AppHandle, Manager, Runtime};

use super::cadence::{
    run_fast_cadence, run_periodic_cadence, SyncScheduler, SyncSchedulers, FAST_PROBE_INTERVAL_SECS,
};
use super::engine::{SyncEngine, SyncEngineDeps};
use super::events::{emitting_event_sink, EventSink};
use super::queue_bridge::{gmail_base_url, registry_executor, WorkRegistry};
use crate::sync::commands;
use crate::{
    auth::AuthService,
    compose::drafts::DraftExecutorContext,
    queue::{Executor, OperationFuture, OperationKind, QueueConfig, QueueEngine, QueueOperation},
    settings::SettingsService,
    storage::Storage,
};

pub struct SyncInitializer<'a, R: Runtime> {
    pub(super) app: &'a AppHandle<R>,
    pub(super) storage: Storage,
    pub(super) directory: PathBuf,
    pub(super) registry: Arc<WorkRegistry>,
    pub(super) events: EventSink,
    pub(super) staging: Option<Arc<crate::compose::staging::Staging>>,
    pub(super) attachment_cache: Option<crate::attachments::AttachmentCache>,
    pub(super) coalescer: Option<Arc<crate::compose::drafts::SaveCoalescer>>,
    pub(super) queue: Option<Arc<QueueEngine>>,
    pub(super) engine: Option<Arc<SyncEngine>>,
}

impl<'a, R: Runtime> SyncInitializer<'a, R> {
    fn new(app: &'a AppHandle<R>, storage: Storage) -> Result<Self, String> {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        Ok(Self {
            app: app,
            storage: storage,
            directory: directory,
            registry: WorkRegistry::new(),
            events: emitting_event_sink(app.clone()),
            staging: None,
            attachment_cache: None,
            coalescer: None,
            queue: None,
            engine: None,
        })
    }

    fn init_staging(mut self) -> Self {
        let staging = Arc::new(crate::compose::staging::Staging::new(
            self.directory.join("compose-staging"),
        ));
        self.app.manage(Arc::clone(&staging));
        self.staging = Some(staging);
        self
    }

    fn init_attachment_cache(mut self) -> Result<Self, String> {
        let cache =
            crate::attachments::AttachmentCache::new(self.directory.join("attachment-cache"))
                .map_err(|error| error.to_string())?;
        self.app.manage(cache.clone());
        spawn_attachment_cache_sweep(cache.clone());
        self.attachment_cache = Some(cache);
        Ok(self)
    }

    fn init_coalescer(mut self) -> Self {
        let coalescer = Arc::new(crate::compose::drafts::SaveCoalescer::new());
        self.app.manage(Arc::clone(&coalescer));
        self.coalescer = Some(coalescer);
        self
    }

    fn init_queue(mut self) -> Self {
        let registry_exec = registry_executor(Arc::clone(&self.registry));
        let compose_exec = crate::compose::drafts::build_executor(DraftExecutorContext {
            app: self.app.clone(),
            storage: self.storage.clone(),
            staging: Arc::clone(self.staging.as_ref().expect("staging initialized")),
            coalescer: Arc::clone(self.coalescer.as_ref().expect("coalescer initialized")),
            base_url: gmail_base_url(),
        });
        let executor = build_queue_executor(compose_exec, registry_exec);
        let queue = QueueEngine::with_config(
            QueueConfig {
                rate_per_second: crate::queue::DEFAULT_RATE_PER_SECOND,
                burst: crate::queue::DEFAULT_BURST,
                events: Arc::clone(&self.events),
                cancellation_hook: build_cancellation_hook(self.app, Arc::clone(&self.registry)),
            },
            executor,
        );
        self.app.manage(Arc::clone(&queue));
        self.queue = Some(queue);
        self
    }

    fn init_engine(mut self) -> Self {
        let engine = SyncEngine::new(SyncEngineDeps {
            storage: self.storage.clone(),
            queue: Arc::clone(self.queue.as_ref().expect("queue initialized")),
            registry: Arc::clone(&self.registry),
            events: Arc::clone(&self.events),
        });
        engine.set_attachment_cache(
            self.attachment_cache
                .clone()
                .expect("attachment cache initialized"),
        );
        self.app.manage(Arc::clone(&engine));
        self.engine = Some(engine);
        self
    }

    fn wire_ai_indexing(self) -> Self {
        let Some(ai) = self.app.try_state::<crate::ai::AiService>() else {
            return self;
        };
        let engine = Arc::clone(self.engine.as_ref().expect("engine initialized"));
        let context = AiIndexingServices {
            app: self.app.clone(),
            ai: ai.inner().clone(),
            engine: Arc::clone(&engine),
        };
        engine.set_ai_catch_up(build_ai_catch_up(context.clone()));
        tauri::async_runtime::spawn(enqueue_startup_ai_accounts(context));
        self
    }

    fn start_schedulers(self) -> Self {
        start_scheduler(
            self.app.clone(),
            Arc::clone(self.engine.as_ref().expect("engine initialized")),
        );
        self
    }

    fn spawn_recovery(self) {
        let Ok(connection) = self.storage.connection() else {
            return;
        };
        let Ok(recovered) = crate::queue::recover_durable_operations(&connection) else {
            return;
        };
        drop(connection);
        let services = RecoveryServices {
            app: self.app.clone(),
            queue: self.queue.expect("queue initialized"),
            engine: self.engine.expect("engine initialized"),
            events: self.events,
        };
        tauri::async_runtime::spawn(run_startup_recovery(services, recovered));
    }
}

fn spawn_attachment_cache_sweep(cache: crate::attachments::AttachmentCache) {
    tauri::async_runtime::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || {
            cache.sweep(crate::attachments::CACHE_CEILING_BYTES)
        })
        .await;
    });
}

fn build_queue_executor(compose_exec: Executor, registry_exec: Executor) -> Executor {
    Arc::new(move |operation: QueueOperation| -> OperationFuture {
        let is_compose = matches!(operation.kind, OperationKind::Draft | OperationKind::Send);
        if is_compose {
            return compose_exec(operation);
        }
        registry_exec(operation)
    })
}

struct AiIndexingServices<R: Runtime> {
    app: AppHandle<R>,
    ai: crate::ai::AiService,
    engine: Arc<SyncEngine>,
}

impl<R: Runtime> Clone for AiIndexingServices<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            ai: self.ai.clone(),
            engine: Arc::clone(&self.engine),
        }
    }
}

impl<R: Runtime> AiIndexingServices<R> {
    fn index_context(&self) -> crate::ai::index::IndexContext<R> {
        crate::ai::index::IndexContext {
            app: self.app.clone(),
            service: self.ai.clone(),
            sync: Arc::clone(&self.engine),
        }
    }
}

fn build_ai_catch_up<R: Runtime>(
    services: AiIndexingServices<R>,
) -> Arc<dyn Fn(String) + Send + Sync> {
    Arc::new(move |account_id| {
        let context = services.index_context();
        tauri::async_runtime::spawn(enqueue_ai_account_if_ready(context, account_id));
    })
}

async fn enqueue_ai_account_if_ready<R: Runtime>(
    context: crate::ai::index::IndexContext<R>,
    account_id: String,
) {
    if !context
        .service
        .index_ready(&account_id)
        .await
        .unwrap_or(false)
    {
        return;
    }
    let _ = crate::ai::index::enqueue(context, account_id).await;
}

async fn enqueue_startup_ai_accounts<R: Runtime>(services: AiIndexingServices<R>) {
    let Ok(configs) = services.ai.configs().await else {
        return;
    };
    for config in configs {
        enqueue_ai_account_if_ready(services.index_context(), config.account_id).await;
    }
}

struct RecoveryServices<R: Runtime> {
    app: AppHandle<R>,
    queue: Arc<QueueEngine>,
    engine: Arc<SyncEngine>,
    events: EventSink,
}

async fn run_startup_recovery<R: Runtime>(
    services: RecoveryServices<R>,
    recovered: crate::queue::RecoveredOperations,
) {
    for operation in &recovered.pending {
        if let Some(queue_operation) = crate::queue::recovered_queue_operation(operation) {
            let _ = services.queue.enqueue(queue_operation).await;
        }
    }
    if recovered.uncertain_accounts.is_empty() {
        return;
    }
    let auth = services.app.state::<AuthService>().inner().clone();
    for account_id in recovered.uncertain_accounts {
        handle_uncertain_account(&services, &auth, account_id).await;
    }
}

async fn handle_uncertain_account<R: Runtime>(
    services: &RecoveryServices<R>,
    auth: &AuthService,
    account_id: String,
) {
    (services.events)(
        crate::events::SEND_UNCERTAIN,
        serde_json::to_value(crate::queue::uncertain_send_event(account_id.clone()))
            .expect("UncertainSendEvent serializes"),
    );
    let Ok(client) = commands::gmail_client_for(
        commands::GmailClientDeps {
            app: &services.app,
            auth: auth,
            engine: &services.engine,
        },
        &account_id,
    )
    .await
    else {
        return;
    };
    let _ = services.engine.run_sync(&account_id, client).await;
}

fn build_cancellation_hook<R: Runtime>(
    app: &AppHandle<R>,
    hook_registry: Arc<WorkRegistry>,
) -> crate::queue::CancellationHook {
    let cancelled_ai = app
        .try_state::<crate::ai::AiService>()
        .map(|state| state.inner().clone());
    let cancellation_app = app.clone();
    Arc::new(move |operation| {
        hook_registry.take(&operation.id);
        if operation.kind != OperationKind::Embed {
            return;
        }
        let Some(ai) = &cancelled_ai else {
            return;
        };
        if ai.is_removing(&operation.account_id).unwrap_or(true)
            || ai.is_reconfiguring(&operation.account_id).unwrap_or(true)
        {
            return;
        }
        let _ = ai.set_index_state(&operation.account_id, crate::ai::IndexState::Interrupted);
        let app = cancellation_app.clone();
        let ai = ai.clone();
        let account_id = operation.account_id.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::ai::index::emit_status(&app, &ai, account_id).await;
        });
    })
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>, storage: Storage) -> Result<(), String> {
    SyncInitializer::new(app, storage)?
        .init_staging()
        .init_attachment_cache()?
        .init_coalescer()
        .init_queue()
        .init_engine()
        .wire_ai_indexing()
        .start_schedulers()
        .spawn_recovery();
    Ok(())
}

struct SchedulerDeps<R: Runtime> {
    app: AppHandle<R>,
    auth: AuthService,
    engine: Arc<SyncEngine>,
}

impl<R: Runtime> Clone for SchedulerDeps<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            auth: self.auth.clone(),
            engine: Arc::clone(&self.engine),
        }
    }
}

struct PeriodicSchedule {
    interval: Duration,
    run_on_startup: bool,
}

fn spawn_fast_scheduler<R: Runtime>(deps: SchedulerDeps<R>) -> Arc<SyncScheduler> {
    SyncScheduler::start(
        Duration::from_secs(FAST_PROBE_INTERVAL_SECS),
        true,
        move || {
            let deps = deps.clone();
            async move {
                run_fast_cadence(&deps.app, &deps.auth, &deps.engine).await;
            }
        },
    )
}

fn spawn_periodic_scheduler<R: Runtime>(
    deps: SchedulerDeps<R>,
    schedule: PeriodicSchedule,
) -> Arc<SyncScheduler> {
    SyncScheduler::start(schedule.interval, schedule.run_on_startup, move || {
        let deps = deps.clone();
        async move {
            run_periodic_cadence(&deps.app, &deps.auth, &deps.engine).await;
        }
    })
}

fn start_scheduler<R: Runtime>(app: AppHandle<R>, engine: Arc<SyncEngine>) {
    let auth = app.state::<AuthService>().inner().clone();
    let settings = app.state::<SettingsService>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let preferences = settings.read().await.unwrap_or_default();
        let periodic_interval = Duration::from_secs(
            u64::from(preferences.sync_interval_seconds)
                .max(crate::settings::MIN_SYNC_INTERVAL_SECS),
        );
        let deps = SchedulerDeps {
            app: app.clone(),
            auth: auth,
            engine: engine,
        };
        let fast = spawn_fast_scheduler(deps.clone());
        let periodic = spawn_periodic_scheduler(
            deps,
            PeriodicSchedule {
                interval: periodic_interval,
                run_on_startup: preferences.sync_on_startup,
            },
        );
        app.manage(SyncSchedulers { fast, periodic });
    });
}
