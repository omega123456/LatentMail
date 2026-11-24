use std::sync::{Arc, Mutex};

use latentmail_lib::events::MAIL_CHANGED;
use latentmail_lib::sync::announce::MailChangeAnnouncer;
use tauri::Listener;

fn recorded_announcements(app: &tauri::App<tauri::test::MockRuntime>) -> Arc<Mutex<Vec<String>>> {
    let announcements = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&announcements);
    app.listen(MAIL_CHANGED, move |event| {
        recorded.lock().unwrap().push(event.payload().to_owned());
    });
    announcements
}

#[test]
fn a_successful_mutation_is_announced_and_its_result_passed_through() {
    let app = tauri::test::mock_app();
    let announcements = recorded_announcements(&app);

    let outcome = MailChangeAnnouncer::new(app.handle(), "account").announce(Ok::<_, String>(7));

    assert_eq!(outcome, Ok(7));
    assert_eq!(
        *announcements.lock().unwrap(),
        [r#"{"accountId":"account"}"#]
    );
}

#[test]
fn a_failed_mutation_is_still_announced_so_optimistic_state_is_reread() {
    let app = tauri::test::mock_app();
    let announcements = recorded_announcements(&app);

    let outcome =
        MailChangeAnnouncer::new(app.handle(), "account").announce(Err::<(), _>("boom".to_owned()));

    assert_eq!(outcome, Err("boom".to_owned()));
    assert_eq!(
        *announcements.lock().unwrap(),
        [r#"{"accountId":"account"}"#]
    );
}
