#[cfg(not(coverage))]
fn main() {
    latentmail_lib::run();
}

#[cfg(coverage)]
fn main() {}
