use latentmail_lib::shell::{prevent_default_flags, prevent_default_plugin};
use tauri::plugin::Plugin;
use tauri_plugin_prevent_default::Flags;

#[test]
fn suppresses_every_browser_affordance_except_reverse_tabbing() {
    let release = prevent_default_flags(false);

    // The right-click menu is the whole point on both Windows and macOS —
    // it is the only pointer rule the plugin has.
    assert!(release.contains(Flags::CONTEXT_MENU));
    assert!(release.contains(Flags::RELOAD));
    assert!(release.contains(Flags::FIND));
    assert!(release.contains(Flags::PRINT));
    assert!(release.contains(Flags::SOURCE));
    assert!(release.contains(Flags::OPEN));
    assert!(release.contains(Flags::DOWNLOADS));
    assert!(release.contains(Flags::CARET_BROWSING));
    assert!(release.contains(Flags::DEV_TOOLS));

    // Shift+Tab is reverse keyboard navigation here, not a browser
    // affordance — blocking it would strand keyboard users in focus traps.
    assert!(!release.contains(Flags::FOCUS_MOVE));
}

#[test]
fn keeps_devtools_reachable_in_debug_builds_only() {
    assert!(!prevent_default_flags(true).contains(Flags::DEV_TOOLS));
    assert!(prevent_default_flags(false).contains(Flags::DEV_TOOLS));

    // Debug relaxes DevTools and nothing else.
    assert_eq!(
        prevent_default_flags(true) | Flags::DEV_TOOLS,
        prevent_default_flags(false)
    );
}

#[test]
fn builds_the_plugin_the_app_registers() {
    assert_eq!(prevent_default_plugin().name(), "prevent-default");
}
