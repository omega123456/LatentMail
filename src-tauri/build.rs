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

fn isolate_debug_identifier() {
    if std::env::var("PROFILE").as_deref() != Ok("debug") {
        return;
    }
    let mut config = serde_json::json!({ "identifier": "com.latentmail.desktop.dev" });
    if let Ok(provided) = std::env::var("TAURI_CONFIG") {
        let provided: serde_json::Value =
            serde_json::from_str(&provided).expect("TAURI_CONFIG is not valid JSON");
        for (key, value) in provided.as_object().into_iter().flatten() {
            config[key] = value.clone();
        }
    }
    let config = config.to_string();
    println!("cargo::rustc-env=TAURI_CONFIG={config}");
    std::env::set_var("TAURI_CONFIG", config);
}

fn main() {
    println!("cargo::rustc-check-cfg=cfg(coverage)");
    isolate_debug_identifier();
    bake_google_credentials();
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "health_check",
            "open_external_url",
            "write_frontend_log",
            "check_for_update",
            "install_update",
        ]),
    ))
    .expect("failed to build Tauri permissions");
}
