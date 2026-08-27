use latentmail_lib::os::autostart::{controller, is_enabled, set_enabled};

#[test]
fn test_utils_autostart_stays_in_memory() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();

    assert!(!is_enabled(app.handle()).unwrap());
    set_enabled(app.handle(), true).unwrap();
    assert!(is_enabled(app.handle()).unwrap());
    set_enabled(app.handle(), false).unwrap();
    assert!(!is_enabled(app.handle()).unwrap());
}

#[test]
fn platform_controller_delegates_to_the_test_only_autostart_store() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let controller = controller(app.handle());

    controller.set_enabled(true).unwrap();
    assert!(controller.is_enabled().unwrap());
    controller.set_enabled(false).unwrap();
    assert!(!controller.is_enabled().unwrap());
}
