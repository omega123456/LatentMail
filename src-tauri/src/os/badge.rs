use std::sync::Arc;
#[cfg(feature = "test-utils")]
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

use tauri::Runtime;

#[cfg(not(feature = "test-utils"))]
use tauri::Manager;

use super::indicator::IndicatorState;

pub trait BadgeController: Send + Sync {
    fn apply(&self, state: &IndicatorState);
    fn applications(&self) -> u64;
    #[cfg(feature = "test-utils")]
    fn snapshot(&self) -> BadgeSnapshot;
}

#[cfg(not(feature = "test-utils"))]
pub fn controller<R: Runtime>(app: &tauri::AppHandle<R>) -> Arc<dyn BadgeController> {
    Arc::new(PlatformBadge { app: app.clone() })
}

#[cfg(feature = "test-utils")]
pub fn controller<R: Runtime>(_app: &tauri::AppHandle<R>) -> Arc<dyn BadgeController> {
    Arc::new(FakeBadgeController::default())
}

#[cfg(not(feature = "test-utils"))]
struct PlatformBadge<R: Runtime> {
    app: tauri::AppHandle<R>,
}

#[cfg(not(feature = "test-utils"))]
impl<R: Runtime> BadgeController for PlatformBadge<R> {
    fn apply(&self, state: &IndicatorState) {
        apply_platform(&self.app, state);
    }

    fn applications(&self) -> u64 {
        0
    }
}

#[cfg(feature = "test-utils")]
#[derive(Default)]
struct FakeBadgeController {
    applications: AtomicU64,
    state: Mutex<BadgeSnapshot>,
}

#[cfg(feature = "test-utils")]
impl BadgeController for FakeBadgeController {
    fn apply(&self, state: &IndicatorState) {
        self.applications.fetch_add(1, Ordering::SeqCst);
        let mut snapshot = self.state.lock().expect("badge state lock poisoned");
        snapshot.dock_badge = Some(state.badge());
        snapshot.overlay = Some(
            state
                .needs_reauthentication
                .then_some(super::icon::DotColor::Reauthentication),
        );
    }

    fn applications(&self) -> u64 {
        self.applications.load(Ordering::SeqCst)
    }

    fn snapshot(&self) -> BadgeSnapshot {
        self.state
            .lock()
            .expect("badge state lock poisoned")
            .clone()
    }
}

#[cfg(feature = "test-utils")]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BadgeSnapshot {
    pub dock_badge: Option<Option<String>>,
    pub overlay: Option<Option<super::icon::DotColor>>,
}

#[cfg(feature = "test-utils")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BadgePlatform {
    Macos,
    Windows,
}

#[cfg(feature = "test-utils")]
#[derive(Debug)]
pub struct FakeBadge {
    platform: BadgePlatform,
    pub dock_badge: Option<Option<String>>,
    pub overlay: Option<Option<super::icon::DotColor>>,
}

#[cfg(feature = "test-utils")]
impl FakeBadge {
    pub fn new(platform: BadgePlatform) -> Self {
        Self {
            platform,
            dock_badge: None,
            overlay: None,
        }
    }

    pub fn apply(&mut self, state: &IndicatorState) {
        match self.platform {
            BadgePlatform::Macos => self.dock_badge = Some(state.badge()),
            BadgePlatform::Windows => {
                self.overlay = Some(
                    state
                        .needs_reauthentication
                        .then_some(super::icon::DotColor::Reauthentication),
                )
            }
        }
    }
}

#[cfg(not(feature = "test-utils"))]
fn apply_platform<R: Runtime>(app: &tauri::AppHandle<R>, state: &IndicatorState) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    #[cfg(target_os = "macos")]
    {
        let _ = window.set_badge_label(state.badge());
    }
    #[cfg(windows)]
    {
        let overlay = state.needs_reauthentication.then(|| {
            let icon = super::icon::reauthentication_overlay();
            tauri::image::Image::new_owned(icon.rgba, icon.width, icon.height)
        });
        let _ = window.set_overlay_icon(overlay);
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = (window, state);
}
