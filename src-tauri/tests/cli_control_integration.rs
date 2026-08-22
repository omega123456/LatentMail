#[cfg(unix)]
use std::sync::Arc;

use latentmail_lib::{
    cli::{apply, parse, run_client, send, serve, socket_path, usage, Command},
    queue::QueueEngine,
};

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
        Some((usage(), 0))
    );
}

#[cfg(unix)]
#[test]
fn socket_path_honors_the_process_override() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("control.sock");
    std::env::set_var("LATENTMAIL_CLI_SOCKET", &path);

    assert_eq!(socket_path(), path);

    std::env::remove_var("LATENTMAIL_CLI_SOCKET");
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
#[tokio::test]
async fn serves_one_json_command_and_rejects_invalid_json() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let directory = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
    let path = directory.path().join("control.sock");
    let queue = QueueEngine::no_op();
    let mut server = tokio::spawn(serve(path.clone(), Arc::clone(&queue)));
    let wait = tokio::time::timeout(
        chrono::Duration::milliseconds(100).to_std().unwrap(),
        async {
            while !path.exists() {
                tokio::time::sleep(chrono::Duration::milliseconds(1).to_std().unwrap()).await;
            }
        },
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
