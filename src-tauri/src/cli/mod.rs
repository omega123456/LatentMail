use std::{io, sync::Arc};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

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

fn select_status_message(
    did_change: bool,
    changed: &'static str,
    unchanged: &'static str,
) -> &'static str {
    if did_change {
        return changed;
    }
    unchanged
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
    let did_change = queue.set_paused(&PauseScope::Global, paused).await;
    let message = select_status_message(did_change, changed, unchanged);
    Response {
        ok: true,
        message: message.into(),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientOutcome {
    pub message: String,
    pub exit_code: i32,
}

pub fn run_client(args: &[String]) -> Option<ClientOutcome> {
    let command = parse(args)?;
    if command == Command::List {
        return Some(ClientOutcome {
            message: usage(),
            exit_code: 0,
        });
    }
    Some(match send(&socket_path(), command) {
        Ok(response) => ClientOutcome {
            message: response.message,
            exit_code: i32::from(!response.ok),
        },
        Err(error) if error.kind() == io::ErrorKind::TimedOut => ClientOutcome {
            message: "Error: no response from LatentMail (timeout).".into(),
            exit_code: 1,
        },
        Err(_) => ClientOutcome {
            message: "LatentMail is not running.".into(),
            exit_code: 1,
        },
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlSocket {
    Spawned,
    Unsupported,
}

#[cfg(any(unix, windows))]
const RESPONSE_TIMEOUT_SECONDS: i64 = 5;
#[cfg(unix)]
const SOCKET_PERMISSIONS: u32 = 0o600;

#[cfg(not(feature = "test-utils"))]
pub fn start<R: Runtime>(app: &AppHandle<R>) -> ControlSocket {
    use tauri::Manager;

    let queue = app.state::<Arc<QueueEngine>>().inner().clone();
    let path = socket_path();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve(path, queue).await {
            tracing::warn!(target: "cli", "terminal sync control unavailable: {error}");
        }
    });
    ControlSocket::Spawned
}

#[cfg(feature = "test-utils")]
pub fn start<R: Runtime>(_app: &AppHandle<R>) -> ControlSocket {
    ControlSocket::Unsupported
}

#[cfg(all(unix, debug_assertions))]
const UNIX_SOCKET_NAME: &str = "latentmail-dev.sock";
#[cfg(all(unix, not(debug_assertions)))]
const UNIX_SOCKET_NAME: &str = "latentmail.sock";

#[cfg(all(windows, debug_assertions))]
const WINDOWS_PIPE_SUFFIX: &str = "-dev";
#[cfg(all(windows, not(debug_assertions)))]
const WINDOWS_PIPE_SUFFIX: &str = "";

#[cfg(unix)]
pub fn socket_path() -> std::path::PathBuf {
    if let Some(path) = std::env::var_os("LATENTMAIL_CLI_SOCKET") {
        return path.into();
    }
    std::env::temp_dir().join(UNIX_SOCKET_NAME)
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
    format!(r"\\.\pipe\latentmail-{username}{WINDOWS_PIPE_SUFFIX}")
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
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(SOCKET_PERMISSIONS))?;
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
        chrono::Duration::seconds(RESPONSE_TIMEOUT_SECONDS)
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
                chrono::Duration::seconds(RESPONSE_TIMEOUT_SECONDS)
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
