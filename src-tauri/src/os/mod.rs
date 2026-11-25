pub mod autostart;
pub mod badge;
pub mod deeplink;
pub mod icon;
pub mod indicator;
pub mod instance;
pub mod lifecycle;
pub mod notifications;
pub mod power;
pub mod tray;
pub mod window;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};
use tokio::sync::Mutex;

use self::deeplink::Mailto;
use self::lifecycle::Lifecycle;

const INDICATOR_DEBOUNCE_MILLISECONDS: i64 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IndicatorApplications {
    pub tray: u64,
    pub badge: u64,
}

#[cfg(feature = "test-utils")]
#[derive(Clone, Debug)]
pub struct PlatformState {
    pub tray: tray::TraySnapshot,
    pub badge: badge::BadgeSnapshot,
}

pub struct OsIntegration {
    tray: Arc<dyn tray::TrayController>,
    badge: Arc<dyn badge::BadgeController>,
    pub(crate) autostart: Arc<dyn autostart::AutostartController>,
    scheduled: AtomicBool,
    frontend_ready: AtomicBool,
    pending_mailto: Arc<Mutex<Vec<Mailto>>>,
    indicator: Arc<Mutex<indicator::IndicatorState>>,
    lifecycle: Option<Arc<Lifecycle>>,
    power: std::sync::Mutex<Option<power::Registration>>,
}

impl OsIntegration {
    pub fn lifecycle(&self) -> Option<&Arc<Lifecycle>> {
        self.lifecycle.as_ref()
    }

    pub async fn indicator(&self) -> indicator::IndicatorState {
        self.indicator.lock().await.clone()
    }

    pub fn indicator_applications(&self) -> IndicatorApplications {
        IndicatorApplications {
            tray: self.tray.applications(),
            badge: self.badge.applications(),
        }
    }

    #[cfg(feature = "test-utils")]
    pub fn platform_state(&self) -> PlatformState {
        PlatformState {
            tray: self.tray.snapshot(),
            badge: self.badge.snapshot(),
        }
    }
}

struct OsInitializer<'a, R: Runtime> {
    app: &'a AppHandle<R>,
}

impl<'a, R: Runtime> OsInitializer<'a, R> {
    fn new(app: &'a AppHandle<R>) -> Self {
        Self { app: app }
    }

    fn build_lifecycle(&self) -> Option<Arc<Lifecycle>> {
        self.app
            .try_state::<Arc<crate::queue::QueueEngine>>()
            .map(|queue| {
                let queue = queue.inner().clone();
                let handle = self.app.clone();
                let resume_work = Arc::new(move || {
                    let app = handle.clone();
                    Box::pin(async move {
                        let auth = app.state::<crate::auth::AuthService>().inner().clone();
                        let engine = app.state::<Arc<crate::sync::SyncEngine>>().inner().clone();
                        crate::sync::run_periodic_cadence(&app, &auth, &engine).await;
                    })
                        as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
                });
                Arc::new(Lifecycle::new(
                    queue,
                    lifecycle::settling_delay(),
                    resume_work,
                ))
            })
    }

    fn install_state(self) -> Self {
        if self.app.try_state::<OsIntegration>().is_some() {
            return self;
        }
        let lifecycle = self.build_lifecycle();
        self.app.manage(OsIntegration {
            tray: tray::controller(self.app),
            badge: badge::controller(self.app),
            autostart: autostart::controller(self.app),
            scheduled: AtomicBool::new(false),
            frontend_ready: AtomicBool::new(false),
            pending_mailto: Arc::new(Mutex::new(Vec::new())),
            indicator: Arc::new(Mutex::new(indicator::IndicatorState::empty())),
            lifecycle: lifecycle.clone(),
            power: std::sync::Mutex::new(None),
        });
        if let Some(lifecycle) = lifecycle {
            let registration = power::register(Arc::new(move |signal| {
                let lifecycle = Arc::clone(&lifecycle);
                tauri::async_runtime::spawn(async move {
                    lifecycle.handle(signal).await;
                });
            }));
            self.app
                .state::<OsIntegration>()
                .power
                .lock()
                .expect("power registration lock poisoned")
                .replace(registration);
        }
        self
    }

    fn initialize_tray_and_notifications(self) -> Result<Self, String> {
        self.app.state::<OsIntegration>().tray.initialize()?;
        notifications::initialize(self.app)?;
        Ok(self)
    }

    fn subscribe_indicators(self) -> Self {
        let schedule_handle = self.app.clone();
        let schedule = move || schedule_indicator_refresh(schedule_handle.clone());
        let mail_schedule = schedule.clone();
        self.app
            .listen(crate::events::MAIL_NEW, move |_| mail_schedule());
        let queue_schedule = schedule.clone();
        self.app
            .listen(crate::events::QUEUE_ITEM, move |_| queue_schedule());
        let initial_schedule = schedule.clone();
        self.app
            .listen(crate::events::ACCOUNT_STATE, move |_| schedule());
        initial_schedule();
        self
    }

    fn subscribe_frontend_ready(self) -> Self {
        let ready_handle = self.app.clone();
        self.app.listen(crate::events::FRONTEND_READY, move |_| {
            flush_pending_mailto(ready_handle.clone());
        });
        self
    }

    fn wire_deep_links(self) -> Self {
        #[cfg(not(feature = "test-utils"))]
        {
            use tauri_plugin_deep_link::DeepLinkExt;

            let handle = self.app.clone();
            self.app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    emit_mailto(&handle, url.as_str());
                }
            });
            if let Ok(Some(urls)) = self.app.deep_link().get_current() {
                for url in urls {
                    emit_mailto(self.app, url.as_str());
                }
            }
        }
        self
    }
}

fn schedule_indicator_refresh<R: Runtime>(app: AppHandle<R>) {
    let integration = app.state::<OsIntegration>();
    if integration.scheduled.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Ok(delay) = chrono::Duration::milliseconds(INDICATOR_DEBOUNCE_MILLISECONDS).to_std()
        else {
            return;
        };
        tokio::time::sleep(delay).await;
        let Some(storage) = app.try_state::<crate::storage::Storage>() else {
            app.state::<OsIntegration>()
                .scheduled
                .store(false, Ordering::SeqCst);
            return;
        };
        if let Ok(state) = indicator::aggregate(storage.inner()).await {
            app.state::<OsIntegration>().tray.apply(&state);
            app.state::<OsIntegration>().badge.apply(&state);
            *app.state::<OsIntegration>().indicator.lock().await = state;
        }
        app.state::<OsIntegration>()
            .scheduled
            .store(false, Ordering::SeqCst);
    });
}

fn flush_pending_mailto<R: Runtime>(app: AppHandle<R>) {
    let integration = app.state::<OsIntegration>();
    if integration.frontend_ready.swap(true, Ordering::SeqCst) {
        return;
    }
    let pending = Arc::clone(&integration.pending_mailto);
    tauri::async_runtime::spawn(async move {
        for mailto in pending.lock().await.drain(..) {
            let _ = app.emit(
                crate::events::OS_INTENT,
                serde_json::json!({ "kind": "mailto", "mailto": mailto }),
            );
        }
    });
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    OsInitializer::new(app)
        .install_state()
        .initialize_tray_and_notifications()?
        .subscribe_indicators()
        .subscribe_frontend_ready()
        .wire_deep_links();
    Ok(())
}

pub fn emit_mailto<R: Runtime>(app: &AppHandle<R>, value: &str) {
    if let Some(mailto) = deeplink::parse(value) {
        window::show_and_focus(app);
        let integration = app.state::<OsIntegration>();
        if !integration.frontend_ready.load(Ordering::SeqCst) {
            let pending = Arc::clone(&integration.pending_mailto);
            tauri::async_runtime::spawn(async move {
                pending.lock().await.push(mailto);
            });
            return;
        }
        let _ = app.emit(
            crate::events::OS_INTENT,
            serde_json::json!({ "kind": "mailto", "mailto": mailto }),
        );
    }
}
