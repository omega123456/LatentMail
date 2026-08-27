use crate::reconcile_staging_integration as cases;

#[test]
fn staging_pages_and_cursor_are_atomic_and_clear_after_completion() {
    cases::keep_cases();
    cases::staging_pages_and_cursor_are_atomic_and_clear_after_completion();
}
