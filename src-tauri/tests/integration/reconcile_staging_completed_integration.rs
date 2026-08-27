use crate::reconcile_staging_integration as cases;

#[tokio::test(flavor = "current_thread")]
async fn completed_reconciliation_cursor_starts_a_fresh_resumable_run() {
    cases::keep_cases();
    cases::completed_reconciliation_cursor_starts_a_fresh_resumable_run().await;
}
