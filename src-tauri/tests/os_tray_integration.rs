use latentmail_lib::os::{
    indicator::IndicatorState,
    tray::{FakeTray, TrayAction},
};

#[test]
fn windows_tray_records_lifecycle_menu_and_actions() {
    let mut tray = FakeTray::windows();
    tray.initialize();
    tray.apply(&IndicatorState {
        unread_count: 12,
        needs_reauthentication: true,
    });
    tray.activate(TrayAction::Reauthenticate);
    tray.activate(TrayAction::Compose);
    tray.activate(TrayAction::Sync);
    tray.activate(TrayAction::Show);
    tray.activate(TrayAction::Quit);
    tray.remove();

    assert!(tray.created);
    assert!(tray.removed);
    assert_eq!(
        tray.tooltip.as_deref(),
        Some("LatentMail — 12 unread — account needs re-authentication")
    );
    assert_eq!(
        tray.menu.unwrap().rows,
        [
            "12 unread messages — account needs re-authentication",
            "Re-authenticate account",
            "Compose New Email",
            "Sync Now",
            "Show window",
            "Quit LatentMail",
        ]
    );
    assert_eq!(
        tray.actions,
        [
            TrayAction::Reauthenticate,
            TrayAction::Compose,
            TrayAction::Sync,
            TrayAction::Show,
            TrayAction::Quit,
        ]
    );
}

#[test]
fn tray_menu_keeps_the_specified_logical_groups() {
    let normal = latentmail_lib::os::tray::menu(&IndicatorState {
        unread_count: 2,
        needs_reauthentication: false,
    });
    let reauthentication = latentmail_lib::os::tray::menu(&IndicatorState {
        unread_count: 2,
        needs_reauthentication: true,
    });

    assert_eq!(normal.separators_after, [1, 3, 4]);
    assert_eq!(reauthentication.separators_after, [1, 4, 5]);
}

#[test]
fn status_row_is_disabled_and_macos_tray_is_a_noop() {
    let mut tray = FakeTray::windows();
    tray.initialize();
    tray.apply(&IndicatorState::empty());
    assert_eq!(
        tray.menu.unwrap().disabled,
        [true, false, false, false, false]
    );

    let mut macos = FakeTray::macos();
    macos.initialize();
    macos.apply(&IndicatorState::empty());
    macos.activate(TrayAction::Compose);
    macos.remove();
    assert!(!macos.created);
    assert!(!macos.removed);
    assert!(macos.tooltip.is_none());
    assert!(macos.menu.is_none());
    assert!(macos.actions.is_empty());
}
