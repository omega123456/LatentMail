use tauri::{Manager, Runtime, Window};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseAction {
    Hide,
    Terminate,
}

pub fn show_and_focus<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn save_geometry<R: Runtime>(app: &tauri::AppHandle<R>) {
    let (Some(window), Some(service)) = (
        app.get_webview_window("main"),
        app.try_state::<crate::settings::SettingsService>(),
    ) else {
        return;
    };
    crate::settings::save_window(&window.as_ref().window(), service.inner());
}

pub fn on_close<R: Runtime>(window: &Window<R>, _event: &tauri::WindowEvent) {
    save_geometry(window.app_handle());
    if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
        if matches!(
            close_action(
                window
                    .app_handle()
                    .state::<crate::settings::SettingsService>()
                    .close_to_tray(),
                cfg!(windows),
                cfg!(target_os = "macos"),
            ),
            CloseAction::Hide
        ) {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

pub fn close_action(close_to_tray: bool, windows: bool, macos: bool) -> CloseAction {
    if macos || (windows && close_to_tray) {
        CloseAction::Hide
    } else {
        CloseAction::Terminate
    }
}

pub fn on_reopen<R: Runtime>(app: &tauri::AppHandle<R>, has_visible_windows: bool) {
    if !has_visible_windows {
        show_and_focus(app);
    }
}

pub fn should_show_on_startup(start_minimized: bool, close_to_tray: bool, windows: bool) -> bool {
    !(windows && start_minimized && close_to_tray)
}
