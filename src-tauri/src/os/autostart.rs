use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};

pub trait AutostartController: Send + Sync {
    fn set_enabled(&self, enabled: bool) -> Result<(), String>;
    fn is_enabled(&self) -> Result<bool, String>;
}

pub fn controller<R: Runtime>(app: &AppHandle<R>) -> Arc<dyn AutostartController> {
    Arc::new(PlatformAutostart { app: app.clone() })
}

struct PlatformAutostart<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> AutostartController for PlatformAutostart<R> {
    fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        set_platform_enabled(&self.app, enabled)
    }

    fn is_enabled(&self) -> Result<bool, String> {
        is_platform_enabled(&self.app)
    }
}

#[cfg(feature = "test-utils")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(feature = "test-utils")]
static ENABLED: AtomicBool = AtomicBool::new(false);

#[cfg(feature = "test-utils")]
fn set_platform_enabled<R: Runtime>(_app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    ENABLED.store(enabled, Ordering::SeqCst);
    Ok(())
}

#[cfg(feature = "test-utils")]
fn is_platform_enabled<R: Runtime>(_app: &AppHandle<R>) -> Result<bool, String> {
    Ok(ENABLED.load(Ordering::SeqCst))
}

#[cfg(all(not(feature = "test-utils"), windows))]
fn set_platform_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;

    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|error| error.to_string())
}

#[cfg(all(not(feature = "test-utils"), windows))]
fn is_platform_enabled<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;

    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[cfg(all(not(feature = "test-utils"), not(windows)))]
fn set_platform_enabled<R: Runtime>(_app: &AppHandle<R>, _enabled: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(all(not(feature = "test-utils"), not(windows)))]
fn is_platform_enabled<R: Runtime>(_app: &AppHandle<R>) -> Result<bool, String> {
    Ok(false)
}

pub fn set_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    app.try_state::<super::OsIntegration>()
        .map(|integration| integration.autostart.set_enabled(enabled))
        .unwrap_or_else(|| set_platform_enabled(app, enabled))
}

pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    app.try_state::<super::OsIntegration>()
        .map(|integration| integration.autostart.is_enabled())
        .unwrap_or_else(|| is_platform_enabled(app))
}
