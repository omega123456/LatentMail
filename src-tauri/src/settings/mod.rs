use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};
use tracing_subscriber::filter::LevelFilter;

use crate::{
    ipc::{AppServices, CommandPayload},
    storage::{SettingRepository, Storage, StorageError},
};

const WINDOW_STATE_KEY: &str = "windowState";
const LOG_LEVEL_KEY: &str = "logLevel";
const START_AT_LOGIN_KEY: &str = "startAtLogin";
const CLOSE_TO_TRAY_KEY: &str = "closeToTray";
const START_MINIMIZED_KEY: &str = "startMinimized";
const SYNC_INTERVAL_SECONDS_KEY: &str = "syncIntervalSeconds";

pub const MIN_SYNC_INTERVAL_SECS: u64 = 15;

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
    pub assistant_width: u32,
    pub sync_on_startup: bool,
    pub show_unread_counts: bool,
    pub sync_interval_seconds: u32,

    pub show_sender_avatars: bool,
    pub zoom_percent: u32,
    pub always_load_remote_images: bool,
    pub allowed_image_senders: Vec<String>,
    pub command_overrides: HashMap<String, Vec<String>>,
    pub log_level: LogLevel,
    pub prefetch_image_attachments: bool,
    pub start_at_login: bool,
    pub close_to_tray: bool,
    pub start_minimized: bool,
    pub desktop_notifications: bool,
    pub update_check_interval: UpdateCheckInterval,
    pub install_update_on_quit: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum UpdateCheckInterval {
    #[serde(rename = "1h")]
    Hourly,
    #[serde(rename = "5h")]
    FiveHours,
    #[serde(rename = "1d")]
    Daily,
    #[serde(rename = "7d")]
    Weekly,
    #[serde(rename = "off")]
    Off,
}

impl From<&LogLevel> for LevelFilter {
    fn from(level: &LogLevel) -> Self {
        match level {
            LogLevel::Debug => LevelFilter::DEBUG,
            LogLevel::Info => LevelFilter::INFO,
            LogLevel::Warn => LevelFilter::WARN,
            LogLevel::Error => LevelFilter::ERROR,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowState {
    #[serde(rename = "x")]
    pub left: i32,
    #[serde(rename = "y")]
    pub top: i32,
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
            assistant_width: 360,
            sync_on_startup: true,
            show_unread_counts: true,
            sync_interval_seconds: u32::try_from(chrono::Duration::minutes(5).num_seconds())
                .expect("five minutes fits in u32 seconds"),
            show_sender_avatars: true,
            zoom_percent: 100,
            always_load_remote_images: false,
            allowed_image_senders: Vec::new(),
            command_overrides: HashMap::new(),
            log_level: LogLevel::Info,
            prefetch_image_attachments: false,
            start_at_login: false,
            close_to_tray: true,
            start_minimized: false,
            desktop_notifications: true,
            update_check_interval: UpdateCheckInterval::Daily,
            install_update_on_quit: true,
        }
    }
}

impl SettingsService {
    pub fn new(storage: Storage) -> Self {
        Self { storage }
    }

    pub async fn read(&self) -> Result<Settings, StorageError> {
        self.storage.run(load_settings_from_connection).await
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

    pub fn log_level(&self) -> LogLevel {
        self.storage
            .connection()
            .ok()
            .and_then(|connection| {
                SettingRepository::get(&connection, LOG_LEVEL_KEY)
                    .ok()
                    .flatten()
            })
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or(LogLevel::Info)
    }

    pub fn close_to_tray(&self) -> bool {
        self.bool_setting(CLOSE_TO_TRAY_KEY, true)
    }

    pub fn start_minimized(&self) -> bool {
        self.bool_setting(START_MINIMIZED_KEY, false)
    }

    pub fn set_start_at_login(&self, enabled: bool) -> Result<(), StorageError> {
        let connection = self.storage.connection()?;
        let value = serde_json::to_string(&enabled).expect("boolean is serializable");
        Ok(SettingRepository::set(
            &connection,
            START_AT_LOGIN_KEY,
            &value,
        )?)
    }

    fn bool_setting(&self, key: &str, default: bool) -> bool {
        self.storage
            .connection()
            .ok()
            .and_then(|connection| SettingRepository::get(&connection, key).ok().flatten())
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or(default)
    }
}

type SettingApplier = fn(&mut Settings, Value) -> bool;

const SETTING_APPLIERS: &[(&str, SettingApplier)] = &[
    ("theme", |settings, value| {
        set_value(&mut settings.theme, value)
    }),
    ("layout", |settings, value| {
        set_value(&mut settings.layout, value)
    }),
    ("density", |settings, value| {
        set_value(&mut settings.density, value)
    }),
    ("sidebarCollapsed", |settings, value| {
        set_value(&mut settings.sidebar_collapsed, value)
    }),
    ("sidebarWidth", |settings, value| {
        set_value(&mut settings.sidebar_width, value)
    }),
    ("listWidth", |settings, value| {
        set_value(&mut settings.list_width, value)
    }),
    ("readerHeight", |settings, value| {
        set_value(&mut settings.reader_height, value)
    }),
    ("assistantWidth", |settings, value| {
        set_value(&mut settings.assistant_width, value)
    }),
    ("syncOnStartup", |settings, value| {
        set_value(&mut settings.sync_on_startup, value)
    }),
    ("showUnreadCounts", |settings, value| {
        set_value(&mut settings.show_unread_counts, value)
    }),
    (SYNC_INTERVAL_SECONDS_KEY, |settings, value| {
        set_value(&mut settings.sync_interval_seconds, value)
    }),
    ("showSenderAvatars", |settings, value| {
        set_value(&mut settings.show_sender_avatars, value)
    }),
    ("zoomPercent", |settings, value| {
        set_value(&mut settings.zoom_percent, value)
    }),
    ("alwaysLoadRemoteImages", |settings, value| {
        set_value(&mut settings.always_load_remote_images, value)
    }),
    ("allowedImageSenders", |settings, value| {
        set_value(&mut settings.allowed_image_senders, value)
    }),
    ("commandOverrides", |settings, value| {
        set_value(&mut settings.command_overrides, value)
    }),
    (LOG_LEVEL_KEY, |settings, value| {
        set_value(&mut settings.log_level, value)
    }),
    ("prefetchImageAttachments", |settings, value| {
        set_value(&mut settings.prefetch_image_attachments, value)
    }),
    (START_AT_LOGIN_KEY, |settings, value| {
        set_value(&mut settings.start_at_login, value)
    }),
    (CLOSE_TO_TRAY_KEY, |settings, value| {
        set_value(&mut settings.close_to_tray, value)
    }),
    (START_MINIMIZED_KEY, |settings, value| {
        set_value(&mut settings.start_minimized, value)
    }),
    ("desktopNotifications", |settings, value| {
        set_value(&mut settings.desktop_notifications, value)
    }),
    ("updateCheckInterval", |settings, value| {
        set_value(&mut settings.update_check_interval, value)
    }),
    ("installUpdateOnQuit", |settings, value| {
        set_value(&mut settings.install_update_on_quit, value)
    }),
];

impl Settings {
    fn apply(&mut self, key: &str, value: Value) -> bool {
        let Some((_, applier)) = SETTING_APPLIERS
            .iter()
            .find(|(entry_key, _)| *entry_key == key)
        else {
            return false;
        };
        applier(self, value)
    }
}

fn load_settings_from_connection(connection: &rusqlite::Connection) -> rusqlite::Result<Settings> {
    let mut settings = Settings::default();
    for entry in SettingRepository::list(connection)? {
        if entry.key == WINDOW_STATE_KEY {
            continue;
        }
        settings.apply(
            &entry.key,
            serde_json::from_str(&entry.value).unwrap_or(Value::Null),
        );
    }
    Ok(settings)
}

fn set_value<T: for<'a> Deserialize<'a>>(target: &mut T, value: Value) -> bool {
    serde_json::from_value(value)
        .map(|value| *target = value)
        .is_ok()
}

type PreWriteHandler<R> = fn(&AppHandle<R>, &Value) -> Result<(), String>;
type LiveHandler<R> = fn(&AppHandle<R>, &Value);

fn apply_start_at_login<R: Runtime>(app: &AppHandle<R>, value: &Value) -> Result<(), String> {
    let enabled = value
        .as_bool()
        .ok_or_else(|| "Unknown or invalid setting: startAtLogin".to_owned())?;
    crate::os::autostart::set_enabled(app, enabled)
}

fn apply_sync_interval<R: Runtime>(app: &AppHandle<R>, value: &Value) {
    let (Some(seconds), Some(schedulers)) = (
        value.as_u64().and_then(|value| u32::try_from(value).ok()),
        app.try_state::<crate::sync::SyncSchedulers>(),
    ) else {
        return;
    };
    schedulers
        .periodic
        .set_interval(std::time::Duration::from_secs(
            u64::from(seconds).max(MIN_SYNC_INTERVAL_SECS),
        ));
}

fn apply_log_level<R: Runtime>(app: &AppHandle<R>, value: &Value) {
    let Ok(level) = serde_json::from_value::<LogLevel>(value.clone()) else {
        return;
    };
    crate::logging::set_level(app, (&level).into());
}

fn pre_write_handler<R: Runtime>(key: &str) -> Option<PreWriteHandler<R>> {
    let handlers: [(&str, PreWriteHandler<R>); 1] = [(START_AT_LOGIN_KEY, apply_start_at_login)];
    handlers
        .into_iter()
        .find(|(entry_key, _)| *entry_key == key)
        .map(|(_, handler)| handler)
}

fn live_handler<R: Runtime>(key: &str) -> Option<LiveHandler<R>> {
    let handlers: [(&str, LiveHandler<R>); 2] = [
        (SYNC_INTERVAL_SECONDS_KEY, apply_sync_interval),
        (LOG_LEVEL_KEY, apply_log_level),
    ];
    handlers
        .into_iter()
        .find(|(entry_key, _)| *entry_key == key)
        .map(|(_, handler)| handler)
}

#[derive(Deserialize)]
pub struct WriteSettingRequest {
    pub key: String,
    pub value: Value,
}

impl SettingsService {
    pub async fn write_live<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: WriteSettingRequest,
    ) -> Result<(), String> {
        if let Some(handler) = pre_write_handler::<R>(&request.key) {
            handler(app, &request.value)?;
        }
        self.write(request.key.clone(), request.value.clone())
            .await?;
        if let Some(handler) = live_handler::<R>(&request.key) {
            handler(app, &request.value);
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn read_settings<R: Runtime>(services: AppServices<'_, R>) -> Result<Settings, String> {
    Ok(string_try!(services.settings()?.read().await))
}

#[tauri::command]
pub async fn write_setting<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<WriteSettingRequest>,
) -> Result<(), String> {
    services
        .settings()?
        .write_live(services.app(), request)
        .await
}

pub fn restore_window<R: Runtime>(window: &WebviewWindow<R>, service: &SettingsService) {
    if let Ok(Some(state)) = service.window_state() {
        let _ = window.set_position(PhysicalPosition::new(state.left, state.top));
        let _ = window.set_size(PhysicalSize::new(state.width, state.height));
        if state.maximized {
            let _ = window.maximize();
        }
    }
}

pub fn save_window<R: Runtime>(window: &tauri::Window<R>, service: &SettingsService) {
    let (Ok(position), Ok(size), Ok(maximized)) = (
        window.outer_position(),
        window.inner_size(),
        window.is_maximized(),
    ) else {
        return;
    };
    let _ = service.save_window_state(&WindowState {
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
        maximized: maximized,
    });
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>, storage: Storage) -> Result<(), String> {
    let service = SettingsService::new(storage);
    crate::logging::set_level(app, (&service.log_level()).into());
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is missing".to_owned())?;
    restore_window(&window, &service);
    if cfg!(windows) {
        let enabled = string_try!(crate::os::autostart::is_enabled(app));
        string_try!(service.set_start_at_login(enabled));
    }
    let show = crate::os::window::should_show_on_startup(
        service.start_minimized(),
        service.close_to_tray(),
        cfg!(windows),
    );
    app.manage(service);
    if show {
        string_try!(window.show());
    }
    Ok(())
}
