//! Desktop-shell hardening.
//!
//! The webview hosting the UI must behave like a native application window,
//! not like a browser tab: no native right-click menu, no reload, no view
//! source, no print dialog, no browser find bar. `tauri-plugin-prevent-default`
//! injects a script that swallows those affordances in the main frame; the
//! sandboxed message-body iframe is out of its reach and cancels its own
//! context menu from the React side instead (`BodyFrame`).

use tauri::plugin::TauriPlugin;
use tauri::Wry;
use tauri_plugin_prevent_default::Flags;

/// Which browser affordances the webview suppresses.
///
/// `Flags::all()` minus:
/// - `FOCUS_MOVE`, which blocks `Shift+Tab`. That is ordinary reverse keyboard
///   navigation in this app (dialogs trap focus, rows and ribbons are
///   tab-reachable), not a browser affordance worth taking away.
/// - `DEV_TOOLS` in debug builds, so the inspector stays reachable under
///   `pnpm dev`. Release builds block it.
pub fn prevent_default_flags(debug: bool) -> Flags {
    let flags = Flags::all().difference(Flags::FOCUS_MOVE);
    if debug {
        flags.difference(Flags::DEV_TOOLS)
    } else {
        flags
    }
}

/// The configured plugin.
///
/// The plugin's built-in keyboard shortcuts match `ctrlKey` only, so on macOS
/// the `Cmd` variants go unblocked — that is fine rather than a gap, because
/// WKWebView exposes none of these accelerators to begin with (no reload, no
/// print, no find bar, no downloads shelf). What macOS does share with Windows
/// is the right-click menu, and `CONTEXT_MENU` is a pointer-event rule that
/// applies identically on both.
pub fn prevent_default_plugin() -> TauriPlugin<Wry> {
    let builder =
        tauri_plugin_prevent_default::Builder::new().with_flags(prevent_default_flags(cfg!(
            debug_assertions
        )));

    #[cfg(windows)]
    let builder = builder.platform(
        tauri_plugin_prevent_default::PlatformOptions::new()
            .general_autofill(false)
            .password_autosave(false)
            // WebView2 drops F12/Ctrl+Shift+I when this is false; keep the
            // accelerators alive in debug so `pnpm dev` can still inspect.
            .browser_accelerator_keys(cfg!(debug_assertions))
            // Enabled at the WebView2 level on purpose: WRY calls
            // `AreDevToolsEnabled(false)` when Tauri's `devtools` feature is
            // off, and some WebView2 runtime builds then render nothing at all.
            // Re-enabling is safe here because every route *to* DevTools is
            // already closed — `Flags::DEV_TOOLS` cancels Ctrl+Shift+I,
            // `browser_accelerator_keys(false)` kills F12, and
            // `Flags::CONTEXT_MENU` removes the "Inspect" entry along with the
            // rest of the native menu.
            .dev_tools(true),
    );

    builder.build()
}
