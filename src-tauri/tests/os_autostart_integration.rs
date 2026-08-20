use latentmail_lib::os::autostart::{is_enabled, set_enabled};

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
