use std::{io, sync::Arc};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::queue::{PauseScope, QueueEngine};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(tag = "command", rename_all = "kebab-case")]
pub enum Command {
    PauseSync,
    ResumeSync,
    List,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct Response {
    pub ok: bool,
    pub message: String,
}

pub fn parse(args: &[String]) -> Option<Command> {
    match args.get(1).map(String::as_str) {
        Some("pause-sync") => Some(Command::PauseSync),
        Some("resume-sync") => Some(Command::ResumeSync),
        Some("list") => Some(Command::List),
        _ => None,
    }
}

pub fn usage() -> String {
    "LatentMail commands:\n  pause-sync   Pause background sync\n  resume-sync  Resume background sync".into()
}

pub async fn apply(command: Command, queue: &Arc<QueueEngine>) -> Response {
    let (paused, changed, unchanged) = match command {
        Command::PauseSync => (true, "Background sync paused.", "Sync is already paused."),
        Command::ResumeSync => (false, "Background sync resumed.", "Sync is not paused."),
        Command::List => {
            return Response {
                ok: true,
                message: usage(),
            };
        }
    };
    let message = if queue.set_paused(&PauseScope::Global, paused).await {
        changed
    } else {
        unchanged
    };
    Response {
        ok: true,
        message: message.into(),
    }
}

pub fn run_client(args: &[String]) -> Option<(String, i32)> {
    let command = parse(args)?;
    if command == Command::List {
        return Some((usage(), 0));
    }
    Some(match send(&socket_path(), command) {
        Ok(response) => (response.message, i32::from(!response.ok)),
        Err(error) if error.kind() == io::ErrorKind::TimedOut => {
            ("Error: no response from LatentMail (timeout).".into(), 1)
        }
        Err(_) => ("LatentMail is not running.".into(), 1),
    })
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let queue = app.state::<Arc<QueueEngine>>().inner().clone();
    let path = socket_path();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve(path, queue).await {
            tracing::warn!(target: "cli", "terminal sync control unavailable: {error}");
        }
    });
}

#[cfg(unix)]
pub fn socket_path() -> std::path::PathBuf {
    if let Some(path) = std::env::var_os("LATENTMAIL_CLI_SOCKET") {
        return path.into();
    }
    std::env::temp_dir().join(if cfg!(debug_assertions) {
        "latentmail-dev.sock"
    } else {
        "latentmail.sock"
    })
}

#[cfg(windows)]
pub fn socket_path() -> String {
    if let Ok(path) = std::env::var("LATENTMAIL_CLI_SOCKET") {
        return path;
    }
    let username: String = std::env::var("USERNAME")
        .unwrap_or_default()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        .collect();
    let suffix = if cfg!(debug_assertions) { "-dev" } else { "" };
    format!(r"\\.\pipe\latentmail-{username}{suffix}")
}

#[cfg(unix)]
pub async fn serve(path: std::path::PathBuf, queue: Arc<QueueEngine>) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    if path.exists() {
        match tokio::net::UnixStream::connect(&path).await {
            Ok(_) => return Err(io::Error::new(io::ErrorKind::AddrInUse, "socket is live")),
            Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
                std::fs::remove_file(&path)?
            }
            Err(error) => return Err(error),
        }
    }
    let listener = UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    loop {
        let (stream, _) = listener.accept().await?;
        handle(stream, Arc::clone(&queue)).await?;
    }
}

#[cfg(any(unix, windows))]
async fn handle<T>(stream: T, queue: Arc<QueueEngine>) -> io::Result<()>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let mut line = String::new();
    let mut stream = BufReader::new(stream);
    stream.read_line(&mut line).await?;
    let response = match serde_json::from_str::<Command>(&line) {
        Ok(command) => apply(command, &queue).await,
        Err(_) => Response {
            ok: false,
            message: "Invalid request.".into(),
        },
    };
    stream
        .get_mut()
        .write_all(serde_json::to_string(&response)?.as_bytes())
        .await?;
    stream.get_mut().write_all(b"\n").await
}

#[cfg(unix)]
pub fn send(path: &std::path::Path, command: Command) -> io::Result<Response> {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    let mut stream = UnixStream::connect(path)?;
    stream.set_read_timeout(Some(
        chrono::Duration::seconds(5)
            .to_std()
            .expect("valid timeout"),
    ))?;
    stream.write_all(serde_json::to_string(&command)?.as_bytes())?;
    stream.write_all(b"\n")?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    serde_json::from_str(&line).map_err(io::Error::other)
}

#[cfg(windows)]
pub async fn serve(path: String, queue: Arc<QueueEngine>) -> io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let mut listener = ServerOptions::new().create(&path)?;
    loop {
        listener.connect().await?;
        handle(&mut listener, Arc::clone(&queue)).await?;
        listener = ServerOptions::new().create(&path)?;
    }
}

#[cfg(windows)]
pub fn send(path: &str, command: Command) -> io::Result<Response> {
    use std::io::{BufRead, BufReader, Write};
    use std::sync::mpsc;

    let mut stream = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?;
    stream.write_all(serde_json::to_string(&command)?.as_bytes())?;
    stream.write_all(b"\n")?;
    let (done, received) = mpsc::channel();
    std::thread::spawn(move || {
        if received
            .recv_timeout(
                chrono::Duration::seconds(5)
                    .to_std()
                    .expect("valid timeout"),
            )
            .is_err()
        {
            eprintln!("Error: no response from LatentMail (timeout).");
            std::process::exit(1);
        }
    });
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    let _ = done.send(());
    serde_json::from_str(&line).map_err(io::Error::other)
}
