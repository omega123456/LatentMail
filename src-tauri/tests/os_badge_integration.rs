use latentmail_lib::os::{
    badge::{BadgePlatform, FakeBadge},
    icon::DotColor,
    indicator::IndicatorState,
};

#[test]
fn macos_badge_records_count_cap_priority_and_clear() {
    let mut badge = FakeBadge::new(BadgePlatform::Macos);
    badge.apply(&IndicatorState {
        unread_count: 120,
        needs_reauthentication: false,
    });
    assert_eq!(badge.dock_badge, Some(Some("99+".to_owned())));
    badge.apply(&IndicatorState {
        unread_count: 120,
        needs_reauthentication: true,
    });
    assert_eq!(badge.dock_badge, Some(Some("!".to_owned())));
    badge.apply(&IndicatorState::empty());
    assert_eq!(badge.dock_badge, Some(None));
    assert!(badge.overlay.is_none());
}

#[test]
fn windows_badge_records_only_reauthentication_overlay() {
    let mut badge = FakeBadge::new(BadgePlatform::Windows);
    badge.apply(&IndicatorState {
        unread_count: 8,
        needs_reauthentication: false,
    });
    assert_eq!(badge.overlay, Some(None));
    badge.apply(&IndicatorState {
        unread_count: 8,
        needs_reauthentication: true,
    });
    assert_eq!(badge.overlay, Some(Some(DotColor::Reauthentication)));
    assert!(badge.dock_badge.is_none());
}
