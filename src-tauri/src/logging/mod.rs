use chrono::{Duration, NaiveDate, Utc};
use std::{fs, path::Path};
use tracing::Dispatch;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{filter::LevelFilter, fmt::writer::MakeWriterExt};

pub const DEFAULT_LEVEL: LevelFilter = LevelFilter::INFO;
const FILE_PREFIX: &str = "latentmail.log.";

pub fn init(directory: impl AsRef<Path>) -> Result<WorkerGuard, Box<dyn std::error::Error>> {
    let (dispatch, guard) = subscriber(directory, DEFAULT_LEVEL)?;
    tracing::dispatcher::set_global_default(dispatch)?;
    Ok(guard)
}

pub fn subscriber(
    directory: impl AsRef<Path>,
    level: LevelFilter,
) -> Result<(Dispatch, WorkerGuard), Box<dyn std::error::Error>> {
    let directory = directory.as_ref();
    fs::create_dir_all(directory)?;
    cleanup(directory, Utc::now().date_naive())?;
    let (writer, guard) = tracing_appender::non_blocking(tracing_appender::rolling::daily(
        directory,
        "latentmail.log",
    ));
    let subscriber = tracing_subscriber::fmt()
        .with_writer(writer.and(std::io::stdout))
        .with_max_level(level)
        .with_ansi(false)
        .finish();
    Ok((Dispatch::new(subscriber), guard))
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
