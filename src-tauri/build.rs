/// Bakes `secrets.json`'s Google OAuth credentials into the binary as
/// compile-time env vars, so sign-in works in `pnpm dev` and in a bundled app
/// without shell variables. Skipped under `test-utils` so integration tests
/// always see an unconfigured client regardless of the developer's local file.
fn bake_google_credentials() {
    println!("cargo::rerun-if-changed=secrets.json");
    if std::env::var_os("CARGO_FEATURE_TEST_UTILS").is_some() {
        return;
    }
    let Ok(raw) = std::fs::read_to_string("secrets.json") else {
        return;
    };
    let secrets: serde_json::Value =
        serde_json::from_str(&raw).expect("secrets.json is not valid JSON");
    for (field, variable) in [
        ("googleClientId", "LATENTMAIL_GOOGLE_CLIENT_ID"),
        ("googleClientSecret", "LATENTMAIL_GOOGLE_CLIENT_SECRET"),
    ] {
        if let Some(value) = secrets[field].as_str() {
            println!("cargo::rustc-env={variable}={}", value.trim());
        }
    }
}

fn main() {
    println!("cargo::rustc-check-cfg=cfg(coverage)");
    bake_google_credentials();
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "health_check",
            "open_external_url",
            "write_frontend_log",
        ]),
    ))
    .expect("failed to build Tauri permissions");
}
