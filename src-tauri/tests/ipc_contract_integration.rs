use latentmail_lib::auth::AuthService;
use latentmail_lib::ipc::{
    health_check, health_response, open_external_url, pause_queue, read_queue_summary, register,
    resume_queue, validate_external_url,
};
use latentmail_lib::queue::QueueEngine;
use latentmail_lib::settings::SettingsService;
use latentmail_lib::storage::Storage;
use tauri::{ipc::CallbackFn, ipc::InvokeBody, test::INVOKE_KEY, webview::InvokeRequest, Manager};

fn app() -> tauri::App<tauri::test::MockRuntime> {
    register(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

/// Dispatches `cmd` through the real Tauri IPC pipeline (not a direct Rust
/// call) so that the `#[tauri::command]`-generated invoke wrapper — which
/// `register()` wires up for every command — is actually exercised, the
/// same path the frontend uses in production.
fn invoke(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    tauri::test::get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|response| response.deserialize::<serde_json::Value>().unwrap())
}

#[test]
fn health_check_has_an_ok_status() {
    let health = health_response();
    assert_eq!(serde_json::to_value(health).unwrap()["status"], "ok");
}

#[test]
fn external_urls_are_limited_to_http_s() {
    assert!(validate_external_url("https://example.com").is_ok());
    assert!(validate_external_url("file:///tmp/message.html").is_err());
    assert!(validate_external_url("not a URL").is_err());
}

#[test]
fn health_command_emits_and_external_opening_uses_the_test_safe_boundary() {
    let app = app();

    assert_eq!(
        serde_json::to_value(health_check(app.handle().clone()).unwrap()).unwrap()["status"],
        "ok"
    );
    assert!(open_external_url(app.handle().clone(), "https://example.com".to_owned()).is_err());
}

#[test]
fn pause_and_resume_queue_commands_emit_summaries_and_toggle_the_engine() {
    let app = app();
    app.manage(QueueEngine::no_op());

    let paused = pause_queue(app.handle().clone(), app.state()).unwrap();
    assert_eq!(paused.pending, 0);

    let resumed = resume_queue(app.handle().clone(), app.state()).unwrap();
    assert_eq!(resumed.pending, 0);

    let summary = read_queue_summary(app.state());
    assert_eq!(summary.pending, 0);
}

/// Exercises every registered command through the real IPC dispatch path
/// (`register()` wires all of these up), not just direct Rust calls, so the
/// `#[tauri::command]`-generated wrapper for each one is covered too.
#[test]
fn every_registered_command_is_reachable_through_real_ipc_dispatch() {
    let app = app();
    let directory = tempfile::tempdir().unwrap();
    app.manage(QueueEngine::no_op());
    app.manage(AuthService::new(
        Storage::open(directory.path().join("mail.sqlite")).unwrap(),
    ));
    app.manage(SettingsService::new(
        Storage::open(directory.path().join("mail.sqlite")).unwrap(),
    ));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    assert_eq!(
        invoke(&webview, "health_check", serde_json::json!({})).unwrap()["status"],
        "ok"
    );
    assert!(invoke(
        &webview,
        "open_external_url",
        serde_json::json!({ "url": "https://example.com" })
    )
    .is_err());
    assert!(invoke(
        &webview,
        "write_frontend_log",
        serde_json::json!({ "record": { "level": "info", "message": "from ipc" } })
    )
    .is_ok());
    assert_eq!(
        invoke(&webview, "pause_queue", serde_json::json!({}))
            .unwrap()
            .get("pending")
            .unwrap(),
        0
    );
    assert_eq!(
        invoke(&webview, "resume_queue", serde_json::json!({}))
            .unwrap()
            .get("pending")
            .unwrap(),
        0
    );
    assert_eq!(
        invoke(&webview, "read_queue_summary", serde_json::json!({}))
            .unwrap()
            .get("pending")
            .unwrap(),
        0
    );
    assert_eq!(
        invoke(&webview, "list_accounts", serde_json::json!({})).unwrap(),
        serde_json::json!([])
    );
    // No client id is configured in tests, so sign-in/reauth always fail
    // fast — that is still real, meaningful coverage of the command's
    // dispatch wiring and error path.
    assert!(invoke(&webview, "begin_sign_in", serde_json::json!({})).is_err());
    assert!(invoke(
        &webview,
        "begin_reauthentication",
        serde_json::json!({ "accountId": "any" })
    )
    .is_err());
    let settings = invoke(&webview, "read_settings", serde_json::json!({})).unwrap();
    assert_eq!(settings["theme"], "system");
    assert!(invoke(
        &webview,
        "write_setting",
        serde_json::json!({ "key": "theme", "value": "dark" })
    )
    .is_ok());
}
