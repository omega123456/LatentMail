use std::sync::Arc;

use super::lifecycle::PowerSignal;

pub type PowerListener = Arc<dyn Fn(PowerSignal) + Send + Sync>;

pub struct Registration {
    #[cfg(all(windows, not(feature = "test-utils")))]
    handle: windows::Win32::System::Power::HPOWERNOTIFY,
    #[cfg(all(windows, not(feature = "test-utils")))]
    parameters: Box<windows::Win32::System::Power::DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS>,
    #[cfg(all(windows, not(feature = "test-utils")))]
    context: *const PowerListener,
    #[cfg(all(target_os = "macos", not(feature = "test-utils")))]
    observers: Vec<
        objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>>,
    >,
}

unsafe impl Send for Registration {}
unsafe impl Sync for Registration {}

#[cfg(feature = "test-utils")]
pub fn register(listener: PowerListener) -> Registration {
    let _ = listener;
    Registration {}
}

#[cfg(all(not(feature = "test-utils"), not(any(windows, target_os = "macos"))))]
pub fn register(listener: PowerListener) -> Registration {
    let _ = listener;
    Registration {}
}

#[cfg(all(windows, not(feature = "test-utils")))]
pub fn register(listener: PowerListener) -> Registration {
    windows_registration(listener)
}

#[cfg(all(target_os = "macos", not(feature = "test-utils")))]
pub fn register(listener: PowerListener) -> Registration {
    macos_registration(listener)
}

#[cfg(all(windows, not(feature = "test-utils")))]
fn windows_registration(listener: PowerListener) -> Registration {
    use windows::Win32::{
        Foundation::HANDLE,
        System::Power::{RegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS},
        UI::WindowsAndMessaging::DEVICE_NOTIFY_CALLBACK,
    };
    let context = Arc::into_raw(Arc::new(listener));
    let parameters = Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
        Callback: Some(windows_callback),
        Context: context.cast_mut().cast(),
    });
    let handle = unsafe {
        RegisterSuspendResumeNotification(
            HANDLE(
                (&*parameters as *const DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS)
                    .cast_mut()
                    .cast(),
            ),
            DEVICE_NOTIFY_CALLBACK,
        )
    }
    .expect("power notification registration failed");
    Registration {
        handle,
        parameters,
        context,
    }
}

#[cfg(all(windows, not(feature = "test-utils")))]
unsafe extern "system" fn windows_callback(
    context: *const core::ffi::c_void,
    event: u32,
    _: *const core::ffi::c_void,
) -> u32 {
    let listener = unsafe { &*(context.cast::<PowerListener>()) };
    match event {
        4 => listener(PowerSignal::Suspend),
        7 | 18 => listener(PowerSignal::Resume),
        _ => {}
    }
    0
}

#[cfg(all(windows, not(feature = "test-utils")))]
impl Drop for Registration {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::System::Power::UnregisterSuspendResumeNotification(self.handle);
            drop(Arc::from_raw(self.context));
        }
    }
}

#[cfg(all(target_os = "macos", not(feature = "test-utils")))]
fn macos_registration(listener: PowerListener) -> Registration {
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    let suspend = block2::RcBlock::new({
        let listener = Arc::clone(&listener);
        move |_: NonNull<NSNotification>| listener(PowerSignal::Suspend)
    });
    let resume =
        block2::RcBlock::new(move |_: NonNull<NSNotification>| listener(PowerSignal::Resume));
    let suspend_observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceWillSleepNotification),
            None,
            None,
            &suspend,
        )
    };
    let resume_observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceDidWakeNotification),
            None,
            None,
            &resume,
        )
    };
    Registration {
        observers: vec![suspend_observer, resume_observer],
    }
}

#[cfg(all(target_os = "macos", not(feature = "test-utils")))]
impl Drop for Registration {
    fn drop(&mut self) {
        self.observers.clear();
    }
}
