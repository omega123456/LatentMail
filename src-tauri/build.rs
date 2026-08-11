fn main() {
    println!("cargo::rustc-check-cfg=cfg(coverage)");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "health_check",
            "open_external_url",
            "write_frontend_log",
        ]),
    ))
    .expect("failed to build Tauri permissions");
}
