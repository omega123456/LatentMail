#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(coverage))]
fn main() {
    latentmail_lib::run();
}

#[cfg(coverage)]
fn main() {}
