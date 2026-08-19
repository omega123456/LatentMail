use chrono::{Duration, NaiveDate, Utc};
use std::{fs, path::Path};
use tauri::{AppHandle, Manager, Runtime};
use tracing::Dispatch;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{
    filter::LevelFilter, fmt, fmt::writer::MakeWriterExt, layer::SubscriberExt, reload, Registry,
};

pub const DEFAULT_LEVEL: LevelFilter = LevelFilter::INFO;
const FILE_PREFIX: &str = "latentmail.log.";

pub type LevelHandle = reload::Handle<LevelFilter, Registry>;

pub fn init(
    directory: impl AsRef<Path>,
) -> Result<(WorkerGuard, LevelHandle), Box<dyn std::error::Error>> {
    let (dispatch, guard, handle) = subscriber(directory, DEFAULT_LEVEL)?;
    tracing::dispatcher::set_global_default(dispatch)?;
    Ok((guard, handle))
}

pub fn subscriber(
    directory: impl AsRef<Path>,
    level: LevelFilter,
) -> Result<(Dispatch, WorkerGuard, LevelHandle), Box<dyn std::error::Error>> {
    let directory = directory.as_ref();
    fs::create_dir_all(directory)?;
    cleanup(directory, Utc::now().date_naive())?;
    let (writer, guard) = tracing_appender::non_blocking(tracing_appender::rolling::daily(
        directory,
        "latentmail.log",
    ));
    let (reload_layer, handle) = reload::Layer::new(level);
    let subscriber = Registry::default().with(reload_layer).with(
        fmt::layer()
            .with_writer(writer.and(std::io::stdout))
            .with_ansi(false),
    );
    Ok((Dispatch::new(subscriber), guard, handle))
}

pub fn set_level<R: Runtime>(app: &AppHandle<R>, level: LevelFilter) {
    if let Some(handle) = app.try_state::<LevelHandle>() {
        let _ = handle.reload(level);
    }
}

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp_millis: i64,
    pub level: String,
    pub message: String,
}

pub fn parse_entries(contents: &str) -> Vec<LogEntry> {
    let mut entries: Vec<LogEntry> = Vec::new();
    for line in contents.lines() {
        match parse_entry_line(line) {
            Some((timestamp_millis, level, message)) => entries.push(LogEntry {
                timestamp_millis,
                level,
                message,
            }),
            None => {
                if let Some(last) = entries.last_mut() {
                    last.message.push('\n');
                    last.message.push_str(line);
                }
            }
        }
    }
    entries
}

fn parse_entry_line(line: &str) -> Option<(i64, String, String)> {
    let mut parts = line.splitn(2, char::is_whitespace);
    let timestamp = chrono::DateTime::parse_from_rfc3339(parts.next()?).ok()?;
    let mut rest = parts.next()?.trim_start().splitn(2, char::is_whitespace);
    let level = rest.next()?.to_owned();
    let message = rest.next().unwrap_or_default().trim_start().to_owned();
    Some((timestamp.timestamp_millis(), level, message))
}

pub fn read_entries(directory: &Path, today: NaiveDate, minimum: usize) -> Vec<LogEntry> {
    let mut entries = read_file_entries(directory, today);
    entries.reverse();
    if entries.len() < minimum {
        let mut yesterday = read_file_entries(directory, today - Duration::days(1));
        yesterday.reverse();
        entries.extend(yesterday.into_iter().take(minimum - entries.len()));
    }
    entries
}

fn read_file_entries(directory: &Path, date: NaiveDate) -> Vec<LogEntry> {
    let path = directory.join(format!("{FILE_PREFIX}{}", date.format("%Y-%m-%d")));
    fs::read_to_string(path)
        .map(|contents| parse_entries(&contents))
        .unwrap_or_default()
}

#[tauri::command]
pub fn read_log_entries<R: Runtime>(app: AppHandle<R>) -> Result<Vec<LogEntry>, String> {
    let directory = app.path().app_log_dir().map_err(|error| error.to_string())?;
    Ok(read_entries(&directory, Utc::now().date_naive(), 100))
}

pub fn cleanup(directory: impl AsRef<Path>, today: NaiveDate) -> std::io::Result<()> {
    let oldest_kept = today - Duration::days(7);
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        let Some(date) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix(FILE_PREFIX))
            .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
        else {
            continue;
        };
        if date < oldest_kept {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}
