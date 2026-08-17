use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

use crate::storage::{SettingRepository, Storage, StorageError};

const WINDOW_STATE_KEY: &str = "windowState";


pub const MIN_SYNC_INTERVAL_SECS: u64 = 15;

macro_rules! string_try {
    ($result:expr) => {
        match $result {
            Ok(value) => value,
            Err(error) => return Err(error.to_string()),
        }
    };
}

#[derive(Clone)]
pub struct SettingsService {
    storage: Storage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: ThemePreference,
    pub layout: Layout,
    pub density: Density,
    pub sidebar_collapsed: bool,
    pub sidebar_width: u32,
    pub list_width: u32,
    pub reader_height: u8,
    pub sync_on_startup: bool,
    pub show_unread_counts: bool,
    pub sync_interval_seconds: u32,

    pub show_sender_avatars: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    Light,
    Dark,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Layout {
    ThreeColumn,
    BottomPreview,
    ListOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Density {
    Compact,
    Comfortable,
    Spacious,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: ThemePreference::System,
            layout: Layout::ThreeColumn,
            density: Density::Comfortable,
            sidebar_collapsed: false,
            sidebar_width: 260,
            list_width: 350,
            reader_height: 40,
            sync_on_startup: true,
            show_unread_counts: true,
            sync_interval_seconds: 30,
            show_sender_avatars: true,
        }
    }
}

impl SettingsService {
    pub fn new(storage: Storage) -> Self {
        Self { storage }
    }

    pub async fn read(&self) -> Result<Settings, StorageError> {
        self.storage
            .run(|connection| {
                let values = SettingRepository::list(connection)?
                    .into_iter()
                    .collect::<HashMap<_, _>>();
                let mut settings = Settings::default();
                for (key, value) in values {
                    if key != WINDOW_STATE_KEY {
                        settings.apply(&key, serde_json::from_str(&value).unwrap_or(Value::Null));
                    }
                }
                Ok(settings)
            })
            .await
    }

    pub async fn write(&self, key: String, value: Value) -> Result<(), String> {
        let mut settings = string_try!(self.read().await);
        if !settings.apply(&key, value.clone()) {
            return Err(format!("Unknown or invalid setting: {key}"));
        }
        let encoded = string_try!(serde_json::to_string(&value));
        string_try!(
            self.storage
                .run(move |connection| SettingRepository::set(connection, &key, &encoded))
                .await
        );
        Ok(())
    }

    pub fn save_window_state(&self, state: &WindowState) -> Result<(), StorageError> {
        let connection = self.storage.connection()?;
        let value = serde_json::to_string(state).expect("window state is serializable");
        SettingRepository::set(&connection, WINDOW_STATE_KEY, &value)?;
        Ok(())
    }

    pub fn window_state(&self) -> Result<Option<WindowState>, StorageError> {
        let connection = self.storage.connection()?;
        Ok(SettingRepository::get(&connection, WINDOW_STATE_KEY)?
            .and_then(|value| serde_json::from_str(&value).ok()))
    }
}

impl Settings {
    fn apply(&mut self, key: &str, value: Value) -> bool {
        match key {
            "theme" => set_value(&mut self.theme, value),
            "layout" => set_value(&mut self.layout, value),
            "density" => set_value(&mut self.density, value),
            "sidebarCollapsed" => set_value(&mut self.sidebar_collapsed, value),
            "sidebarWidth" => set_value(&mut self.sidebar_width, value),
            "listWidth" => set_value(&mut self.list_width, value),
            "readerHeight" => set_value(&mut self.reader_height, value),
            "syncOnStartup" => set_value(&mut self.sync_on_startup, value),
            "showUnreadCounts" => set_value(&mut self.show_unread_counts, value),
            "syncIntervalSeconds" => set_value(&mut self.sync_interval_seconds, value),
            "showSenderAvatars" => set_value(&mut self.show_sender_avatars, value),
            _ => false,
        }
    }
}

fn set_value<T: for<'a> Deserialize<'a>>(target: &mut T, value: Value) -> bool {
    serde_json::from_value(value)
        .map(|value| *target = value)
        .is_ok()
}

#[tauri::command]
pub async fn read_settings(service: tauri::State<'_, SettingsService>) -> Result<Settings, String> {
    Ok(string_try!(service.read().await))
}

#[tauri::command]
pub async fn write_setting<R: Runtime>(
    app: AppHandle<R>,
    service: tauri::State<'_, SettingsService>,
    key: String,
    value: Value,
) -> Result<(), String> {
    service.write(key.clone(), value.clone()).await?;
    apply_live(&app, &key, &value);
    Ok(())
}


fn apply_live<R: Runtime>(app: &AppHandle<R>, key: &str, value: &Value) {
    if key != "syncIntervalSeconds" {
        return;
    }
    let (Some(seconds), Some(scheduler)) = (
        value.as_u64().and_then(|value| u32::try_from(value).ok()),
        app.try_state::<std::sync::Arc<crate::sync::SyncScheduler>>(),
    ) else {
        return;
    };
    scheduler.set_interval(std::time::Duration::from_secs(
        u64::from(seconds).max(MIN_SYNC_INTERVAL_SECS),
    ));
}

pub fn restore_window<R: Runtime>(window: &WebviewWindow<R>, service: &SettingsService) {
    if let Ok(Some(state)) = service.window_state() {
        let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
        let _ = window.set_size(PhysicalSize::new(state.width, state.height));
        if state.maximized {
            let _ = window.maximize();
        }
    }
}

pub fn save_window<R: Runtime>(window: &tauri::Window<R>, service: &SettingsService) {
    let (Ok(position), Ok(size), Ok(maximized)) = (
        window.outer_position(),
        window.outer_size(),
        window.is_maximized(),
    ) else {
        return;
    };
    let _ = service.save_window_state(&WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
    });
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let directory = string_try!(app.path().app_data_dir());
    string_try!(std::fs::create_dir_all(&directory));
    let service = SettingsService::new(string_try!(Storage::open(
        directory.join("latentmail.sqlite")
    )));
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is missing".to_owned())?;
    restore_window(&window, &service);
    app.manage(service);
    string_try!(window.show());
    Ok(())
}
