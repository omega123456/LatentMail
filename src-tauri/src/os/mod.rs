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

    pub fn indicator_applications(&self) -> (u64, u64) {
        (self.tray.applications(), self.badge.applications())
    }

    #[cfg(feature = "test-utils")]
    pub fn platform_state(&self) -> (tray::TraySnapshot, badge::BadgeSnapshot) {
        (self.tray.snapshot(), self.badge.snapshot())
    }
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if app.try_state::<OsIntegration>().is_none() {
        let lifecycle = app
            .try_state::<Arc<crate::queue::QueueEngine>>()
            .map(|queue| {
                let queue = queue.inner().clone();
                let handle = app.clone();
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
            });
        app.manage(OsIntegration {
            tray: tray::controller(app),
            badge: badge::controller(app),
            autostart: autostart::controller(app),
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
            app.state::<OsIntegration>()
                .power
                .lock()
                .expect("power registration lock poisoned")
                .replace(registration);
        }
    }
    app.state::<OsIntegration>().tray.initialize()?;
    notifications::initialize(app)?;
    let handle = app.clone();
    let schedule = move || {
        let app = handle.clone();
        let integration = app.state::<OsIntegration>();
        if integration.scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        tauri::async_runtime::spawn(async move {
            let Ok(delay) = chrono::Duration::milliseconds(100).to_std() else {
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
    };
    let mail_schedule = schedule.clone();
    app.listen("mail://new", move |_| mail_schedule());
    let queue_schedule = schedule.clone();
    app.listen("queue://item", move |_| queue_schedule());
    let initial_schedule = schedule.clone();
    app.listen("account://state", move |_| schedule());
    let ready_handle = app.clone();
    app.listen("frontend://ready", move |_| {
        let integration = ready_handle.state::<OsIntegration>();
        if integration.frontend_ready.swap(true, Ordering::SeqCst) {
            return;
        }
        let pending = Arc::clone(&integration.pending_mailto);
        let app = ready_handle.clone();
        tauri::async_runtime::spawn(async move {
            for mailto in pending.lock().await.drain(..) {
                let _ = app.emit(
                    "os://intent",
                    serde_json::json!({ "kind": "mailto", "mailto": mailto }),
                );
            }
        });
    });
    initial_schedule();
    #[cfg(not(feature = "test-utils"))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;

        let handle = app.clone();
        app.deep_link().on_open_url(move |event| {
            for url in event.urls() {
                emit_mailto(&handle, url.as_str());
            }
        });
        if let Ok(Some(urls)) = app.deep_link().get_current() {
            for url in urls {
                emit_mailto(app, url.as_str());
            }
        }
    }
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
            "os://intent",
            serde_json::json!({ "kind": "mailto", "mailto": mailto }),
        );
    }
}
