use std::time::Duration;

use latentmail_lib::{
    app_runtime::{
        confirm_and_exit, exit_confirmation_message, handle_run_event, handle_window_event,
        open_storage_in, register_image_protocols, run_vacuum_step, spawn_vacuum_loop, vacuum_loop,
    },
    http_client, os,
    queue::QueueEngine,
    storage::Storage,
};

use tauri::Manager;

use crate::support;

const FIRST_VACUUM_GRACE: Duration = Duration::from_millis(50);

fn temporary_storage() -> (tempfile::TempDir, Storage) {
    let directory = tempfile::tempdir().unwrap();
    let storage = open_storage_in(directory.path()).unwrap();
    (directory, storage)
}

#[test]
fn opening_storage_creates_the_directory_and_the_database_file() {
    let parent = tempfile::tempdir().unwrap();
    let directory = parent.path().join("nested").join("data");

    let storage = open_storage_in(&directory).unwrap();

    assert!(directory.join("latentmail.sqlite").exists());
    assert!(storage.connection().is_ok());
}

#[tokio::test]
async fn a_vacuum_step_runs_against_open_storage() {
    let (_directory, storage) = temporary_storage();

    run_vacuum_step(&storage).await;

    assert!(storage.connection().is_ok());
}

#[tokio::test(start_paused = true)]
async fn the_vacuum_loop_vacuums_on_its_first_tick_and_keeps_running() {
    let (_directory, storage) = temporary_storage();

    let still_running = tokio::time::timeout(FIRST_VACUUM_GRACE, vacuum_loop(storage)).await;

    assert!(still_running.is_err());
}

#[test]
fn spawning_the_vacuum_loop_returns_immediately() {
    let (_directory, storage) = temporary_storage();

    spawn_vacuum_loop(storage);
}

#[test]
fn the_image_protocols_register_on_a_builder_that_still_builds() {
    let builder = register_image_protocols(tauri::test::mock_builder(), http_client());

    let application = builder.build(tauri::test::mock_context(tauri::test::noop_assets()));

    assert!(application.is_ok());
}

#[test]
fn no_exit_confirmation_is_asked_without_os_integration() {
    let application = support::app();

    assert_eq!(exit_confirmation_message(application.handle(), None), None);
    assert_eq!(
        exit_confirmation_message(application.handle(), Some(tauri::RESTART_EXIT_CODE)),
        None
    );
}

#[test]
fn an_idle_lifecycle_lets_the_app_exit_without_asking() {
    let application = support::app();
    application.manage(QueueEngine::no_op());
    os::initialize(application.handle()).unwrap();

    assert!(application
        .state::<os::OsIntegration>()
        .lifecycle()
        .is_some());
    assert_eq!(exit_confirmation_message(application.handle(), None), None);
}

#[test]
fn choosing_to_wait_keeps_the_app_running() {
    let application = support::app();

    confirm_and_exit(application.handle(), true);

    assert!(application.handle().webview_windows().is_empty());
}

#[test]
fn run_events_other_than_exit_and_reopen_are_ignored() {
    let application = support::app();

    handle_run_event(application.handle(), tauri::RunEvent::Ready);
    handle_run_event(application.handle(), tauri::RunEvent::MainEventsCleared);
}

#[test]
fn window_events_other_than_close_are_ignored() {
    let application = support::app();
    let webview = tauri::WebviewWindowBuilder::new(&application, "main", Default::default())
        .build()
        .unwrap();

    let window = webview.as_ref().window();

    handle_window_event(&window, &tauri::WindowEvent::Focused(true));

    assert!(application.handle().get_webview_window("main").is_some());
}
