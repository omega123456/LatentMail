use std::sync::Arc;
#[cfg(feature = "test-utils")]
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

use super::indicator::IndicatorState;

pub trait TrayController: Send + Sync {
    fn initialize(&self) -> Result<(), String>;
    fn apply(&self, state: &IndicatorState);
    fn applications(&self) -> u64;
    #[cfg(feature = "test-utils")]
    fn snapshot(&self) -> TraySnapshot;
}

#[cfg(not(feature = "test-utils"))]
pub fn controller<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Arc<dyn TrayController> {
    Arc::new(PlatformTray { app: app.clone() })
}

#[cfg(feature = "test-utils")]
pub fn controller<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> Arc<dyn TrayController> {
    Arc::new(FakeTrayController::default())
}

#[cfg(not(feature = "test-utils"))]
struct PlatformTray<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

#[cfg(not(feature = "test-utils"))]
impl<R: tauri::Runtime> TrayController for PlatformTray<R> {
    fn initialize(&self) -> Result<(), String> {
        initialize_platform(&self.app)
    }

    fn apply(&self, state: &IndicatorState) {
        apply_platform(&self.app, state);
    }

    fn applications(&self) -> u64 {
        0
    }
}

#[cfg(feature = "test-utils")]
#[derive(Default)]
struct FakeTrayController {
    applications: AtomicU64,
    state: Mutex<TraySnapshot>,
}

#[cfg(feature = "test-utils")]
impl TrayController for FakeTrayController {
    fn initialize(&self) -> Result<(), String> {
        self.state.lock().expect("tray state lock poisoned").created = true;
        Ok(())
    }

    fn apply(&self, state: &IndicatorState) {
        self.applications.fetch_add(1, Ordering::SeqCst);
        let mut snapshot = self.state.lock().expect("tray state lock poisoned");
        snapshot.tooltip = Some(state.tooltip());
        snapshot.menu = Some(menu(state));
        snapshot.icon = state
            .needs_reauthentication
            .then_some(super::icon::DotColor::Reauthentication)
            .or_else(|| (state.unread_count > 0).then_some(super::icon::DotColor::Unread));
    }

    fn applications(&self) -> u64 {
        self.applications.load(Ordering::SeqCst)
    }

    fn snapshot(&self) -> TraySnapshot {
        self.state.lock().expect("tray state lock poisoned").clone()
    }
}

#[cfg(feature = "test-utils")]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TraySnapshot {
    pub created: bool,
    pub tooltip: Option<String>,
    pub menu: Option<TrayMenu>,
    pub icon: Option<super::icon::DotColor>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayMenu {
    pub rows: Vec<String>,
    pub disabled: Vec<bool>,
    pub separators_after: Vec<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayAction {
    Compose,
    Sync,
    Reauthenticate,
    Show,
    Quit,
}

fn menu_separators(needs_reauthentication: bool) -> Vec<usize> {
    if needs_reauthentication {
        return vec![1, 4, 5];
    }
    vec![1, 3, 4]
}

pub fn menu(state: &IndicatorState) -> TrayMenu {
    let mut rows = vec![state.status_row()];
    if state.needs_reauthentication {
        rows.push("Re-authenticate account".to_owned());
    }
    rows.extend([
        "Compose New Email".to_owned(),
        "Sync Now".to_owned(),
        "Show window".to_owned(),
        "Quit LatentMail".to_owned(),
    ]);
    TrayMenu {
        disabled: std::iter::once(true)
            .chain(std::iter::repeat(false))
            .take(rows.len())
            .collect(),
        separators_after: menu_separators(state.needs_reauthentication),
        rows: rows,
    }
}

#[cfg(feature = "test-utils")]
#[derive(Default)]
pub struct FakeTray {
    pub created: bool,
    pub removed: bool,
    pub tooltip: Option<String>,
    pub menu: Option<TrayMenu>,
    pub actions: Vec<TrayAction>,
    windows: bool,
}

#[cfg(feature = "test-utils")]
impl FakeTray {
    pub fn windows() -> Self {
        Self {
            windows: true,
            ..Self::default()
        }
    }

    pub fn macos() -> Self {
        Self::default()
    }

    pub fn initialize(&mut self) {
        self.created = self.windows;
    }

    pub fn apply(&mut self, state: &IndicatorState) {
        if self.windows {
            self.tooltip = Some(state.tooltip());
            self.menu = Some(menu(state));
        }
    }

    pub fn remove(&mut self) {
        self.removed = self.windows && self.created;
    }

    pub fn activate(&mut self, action: TrayAction) {
        if self.windows {
            self.actions.push(action);
        }
    }
}

#[cfg(all(windows, not(feature = "test-utils")))]
struct TrayMenuBinding {
    id: &'static str,
    focus_window: bool,
    intent_kind: Option<&'static str>,
    exit_app: bool,
}

#[cfg(all(windows, not(feature = "test-utils")))]
const TRAY_MENU_BINDINGS: &[TrayMenuBinding] = &[
    TrayMenuBinding {
        id: "compose",
        focus_window: true,
        intent_kind: Some("compose"),
        exit_app: false,
    },
    TrayMenuBinding {
        id: "sync",
        focus_window: false,
        intent_kind: Some("syncNow"),
        exit_app: false,
    },
    TrayMenuBinding {
        id: "reauthenticate",
        focus_window: true,
        intent_kind: Some("openAccounts"),
        exit_app: false,
    },
    TrayMenuBinding {
        id: "show",
        focus_window: true,
        intent_kind: None,
        exit_app: false,
    },
    TrayMenuBinding {
        id: "quit",
        focus_window: false,
        intent_kind: None,
        exit_app: true,
    },
];

#[cfg(all(windows, not(feature = "test-utils")))]
fn dispatch_tray_menu_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, menu_id: &str) {
    use tauri::Emitter;

    let Some(binding) = TRAY_MENU_BINDINGS.iter().find(|entry| entry.id == menu_id) else {
        return;
    };
    if binding.exit_app {
        app.exit(0);
        return;
    }
    if binding.focus_window {
        crate::os::window::show_and_focus(app);
    }
    if let Some(kind) = binding.intent_kind {
        let _ = app.emit(
            crate::events::OS_INTENT,
            serde_json::json!({ "kind": kind }),
        );
    }
}

#[cfg(all(windows, not(feature = "test-utils")))]
fn initialize_platform<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    use tauri::{menu::Menu, tray::TrayIconBuilder};

    let icon = super::icon::tray_icon(0, false)?;
    let menu = Menu::with_items(app, &[]).map_err(|error| error.to_string())?;
    let handle = app.clone();
    TrayIconBuilder::with_id("mail")
        .icon(tauri::image::Image::new_owned(
            icon.rgba,
            icon.width,
            icon.height,
        ))
        .tooltip("LatentMail — 0 unread")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| dispatch_tray_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(move |_, event| {
            if matches!(
                event,
                tauri::tray::TrayIconEvent::Click {
                    button: tauri::tray::MouseButton::Left,
                    ..
                }
            ) {
                crate::os::window::show_and_focus(&handle);
            }
        })
        .build(app)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(all(windows, not(feature = "test-utils")))]
fn apply_platform<R: tauri::Runtime>(app: &tauri::AppHandle<R>, state: &IndicatorState) {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    let Some(tray) = app.tray_by_id("mail") else {
        return;
    };
    let status = MenuItem::with_id(app, "status", state.status_row(), false, None::<&str>);
    let compose = MenuItem::with_id(app, "compose", "Compose New Email", true, None::<&str>);
    let sync = MenuItem::with_id(app, "sync", "Sync Now", true, None::<&str>);
    let show = MenuItem::with_id(app, "show", "Show window", true, None::<&str>);
    let quit = MenuItem::with_id(app, "quit", "Quit LatentMail", true, None::<&str>);
    let reauthenticate = state.needs_reauthentication.then(|| {
        MenuItem::with_id(
            app,
            "reauthenticate",
            "Re-authenticate account",
            true,
            None::<&str>,
        )
    });
    let (Ok(status), Ok(compose), Ok(sync), Ok(show), Ok(quit)) =
        (status, compose, sync, show, quit)
    else {
        return;
    };
    let first_separator = PredefinedMenuItem::separator(app);
    let second_separator = PredefinedMenuItem::separator(app);
    let third_separator = PredefinedMenuItem::separator(app);
    let (Ok(first_separator), Ok(second_separator), Ok(third_separator)) =
        (first_separator, second_separator, third_separator)
    else {
        return;
    };
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![&status, &first_separator];
    if let Some(Ok(item)) = reauthenticate.as_ref() {
        items.push(item);
    }
    items.push(&compose);
    items.push(&sync);
    items.push(&second_separator);
    items.push(&show);
    items.push(&third_separator);
    items.push(&quit);
    if let Ok(menu) = Menu::with_items(app, &items) {
        if let Ok(icon) = super::icon::tray_icon(state.unread_count, state.needs_reauthentication) {
            let _ = tray.set_icon(Some(tauri::image::Image::new_owned(
                icon.rgba,
                icon.width,
                icon.height,
            )));
        }
        let _ = tray.set_menu(Some(menu));
        let _ = tray.set_tooltip(Some(state.tooltip()));
    }
}

#[cfg(all(not(windows), not(feature = "test-utils")))]
fn apply_platform<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, _state: &IndicatorState) {}

#[cfg(all(not(windows), not(feature = "test-utils")))]
fn initialize_platform<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> Result<(), String> {
    Ok(())
}
