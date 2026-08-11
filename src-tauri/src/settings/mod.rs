use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

use crate::storage::{SettingRepository, Storage, StorageError};

const WINDOW_STATE_KEY: &str = "windowState";

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
    pub sync_interval_minutes: u32,
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
            sync_interval_minutes: 5,
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
        let mut settings = self.read().await.map_err(|error| error.to_string())?;
        if !settings.apply(&key, value.clone()) {
            return Err(format!("Unknown or invalid setting: {key}"));
        }
        let encoded = serde_json::to_string(&value).map_err(|error| error.to_string())?;
        self.storage
            .run(move |connection| SettingRepository::set(connection, &key, &encoded))
            .await
            .map_err(|error| error.to_string())
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
            "syncIntervalMinutes" => set_value(&mut self.sync_interval_minutes, value),
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
    service.read().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn write_setting(
    service: tauri::State<'_, SettingsService>,
    key: String,
    value: Value,
) -> Result<(), String> {
    service.write(key, value).await
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
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let service = SettingsService::new(
        Storage::open(directory.join("latentmail.sqlite")).map_err(|error| error.to_string())?,
    );
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is missing".to_owned())?;
    restore_window(&window, &service);
    app.manage(service);
    window.show().map_err(|error| error.to_string())
}
