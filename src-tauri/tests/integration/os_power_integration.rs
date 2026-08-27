use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use latentmail_lib::os::{lifecycle::PowerSignal, power};

#[test]
fn test_power_registration_never_invokes_the_listener() {
    let signals = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&signals);
    let _registration = power::register(Arc::new(move |_: PowerSignal| {
        seen.fetch_add(1, Ordering::Relaxed);
    }));
    assert_eq!(signals.load(Ordering::Relaxed), 0);
}
