use std::sync::Arc;

use latentmail_lib::{
    cli::{
        apply, parse, run_client, send, serve, socket_path, start, usage, Command, ControlSocket,
    },
    queue::QueueEngine,
};

#[test]
fn starting_the_control_socket_is_unsupported_under_test_utils() {
    let app = tauri::test::mock_app();

    assert_eq!(start(app.handle()), ControlSocket::Unsupported);
}

#[test]
fn parses_only_terminal_sync_commands() {
    assert_eq!(
        parse(&["latentmail".into(), "pause-sync".into()]),
        Some(Command::PauseSync)
    );
    assert_eq!(
        parse(&["latentmail".into(), "resume-sync".into()]),
        Some(Command::ResumeSync)
    );
    assert_eq!(
        parse(&["latentmail".into(), "list".into()]),
        Some(Command::List)
    );
    assert_eq!(
        parse(&["latentmail".into(), "mailto:a@example.com".into()]),
        None
    );
    assert_eq!(parse(&["latentmail".into(), "unknown".into()]), None);
}

#[test]
fn lists_the_sync_commands() {
    assert!(usage().contains("pause-sync"));
    assert!(usage().contains("resume-sync"));
    assert_eq!(
        run_client(&["latentmail".into(), "list".into()]),
        Some(latentmail_lib::cli::ClientOutcome {
            message: usage(),
            exit_code: 0,
        })
    );
}

#[cfg(unix)]
#[test]
fn socket_path_honors_the_process_override() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("control.sock");
    crate::support::set_env("LATENTMAIL_CLI_SOCKET", &path);

    assert_eq!(socket_path(), path);

    crate::support::remove_env("LATENTMAIL_CLI_SOCKET");
}

#[tokio::test]
async fn applies_idempotent_global_pause_state() {
    let queue = QueueEngine::no_op();

    assert_eq!(apply(Command::List, &queue).await.message, usage());
    assert_eq!(
        apply(Command::PauseSync, &queue).await.message,
        "Background sync paused."
    );
    assert!(queue.summary().paused);
    assert_eq!(
        apply(Command::PauseSync, &queue).await.message,
        "Sync is already paused."
    );
    assert_eq!(
        apply(Command::ResumeSync, &queue).await.message,
        "Background sync resumed."
    );
    assert!(!queue.summary().paused);
    assert_eq!(
        apply(Command::ResumeSync, &queue).await.message,
        "Sync is not paused."
    );
}

#[cfg(unix)]
async fn wait_for_socket(path: &std::path::Path) {
    while !path.exists() {
        tokio::time::sleep(chrono::Duration::milliseconds(1).to_std().unwrap()).await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn serves_one_json_command_and_rejects_invalid_json() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let directory = tempfile::Builder::new()
        .prefix("lm")
        .tempdir_in("/tmp")
        .unwrap();
    let path = directory.path().join("control.sock");
    let queue = QueueEngine::no_op();
    let mut server = tokio::spawn(serve(path.clone(), Arc::clone(&queue)));
    let wait = tokio::time::timeout(
        chrono::Duration::milliseconds(100).to_std().unwrap(),
        wait_for_socket(&path),
    );
    tokio::select! {
        result = &mut server => panic!("server stopped: {result:?}"),
        result = wait => result.unwrap(),
    }
    let response = tokio::task::spawn_blocking({
        let path = path.clone();
        move || send(&path, Command::PauseSync)
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.message, "Background sync paused.");

    let mut stream = tokio::net::UnixStream::connect(&path).await.unwrap();
    stream.write_all(b"nope\n").await.unwrap();
    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .await
        .unwrap();
    assert!(response.contains("Invalid request."));
    server.abort();
}

#[cfg(unix)]
#[test]
fn reports_when_no_listener_is_running() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("missing.sock");
    assert!(send(&path, Command::PauseSync).is_err());
}

#[cfg(windows)]
const TEST_PIPE_PREFIX: &str = r"\\.\pipe\latentmail-test-";

#[cfg(windows)]
#[test]
fn pipe_name_honors_the_process_override() {
    let override_path = format!("{TEST_PIPE_PREFIX}override");
    crate::support::set_env("LATENTMAIL_CLI_SOCKET", &override_path);

    assert_eq!(socket_path(), override_path);

    crate::support::remove_env("LATENTMAIL_CLI_SOCKET");
}

#[cfg(windows)]
#[test]
fn pipe_name_keeps_only_safe_characters_of_the_user_name() {
    crate::support::remove_env("LATENTMAIL_CLI_SOCKET");
    crate::support::set_env("USERNAME", "jo hn.doe_1-x");

    assert!(socket_path().starts_with(r"\\.\pipe\latentmail-johndoe_1-x"));
}

#[cfg(windows)]
fn send_once_listening(path: &str) -> latentmail_lib::cli::Response {
    let deadline = std::time::Instant::now() + chrono::Duration::seconds(1).to_std().unwrap();
    loop {
        let attempt = send(path, Command::PauseSync);
        let out_of_time = std::time::Instant::now() >= deadline;
        let finished = attempt.is_ok() || out_of_time;
        if finished {
            return attempt.unwrap();
        }
        std::thread::sleep(chrono::Duration::milliseconds(1).to_std().unwrap());
    }
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn serves_one_json_command_over_a_named_pipe() {
    let path = format!("{TEST_PIPE_PREFIX}{}", std::process::id());
    let queue = QueueEngine::no_op();
    let server = tokio::spawn(serve(path.clone(), Arc::clone(&queue)));

    let response = tokio::task::spawn_blocking(move || send_once_listening(&path))
        .await
        .unwrap();

    assert_eq!(response.message, "Background sync paused.");
    assert!(queue.summary().paused);
    server.abort();
}

#[cfg(windows)]
#[test]
fn reports_when_no_pipe_listener_is_running() {
    let path = format!("{TEST_PIPE_PREFIX}missing-{}", std::process::id());

    assert!(send(&path, Command::PauseSync).is_err());
}
