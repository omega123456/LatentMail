use latentmail_lib::updater::{check_for_update, install_update};

fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

#[tokio::test]
async fn check_for_update_reports_no_available_update_under_test_utils() {
    let app = mock_app();

    let result = check_for_update(app.handle().clone()).await.unwrap();

    assert!(result.available.is_none());
    assert!(!result.current_version.is_empty());
}

#[tokio::test]
async fn install_update_is_unsupported_under_test_utils() {
    let app = mock_app();

    let error = install_update(app.handle().clone()).await.unwrap_err();

    assert!(error.contains("Update installation is unsupported in this build"));
}
