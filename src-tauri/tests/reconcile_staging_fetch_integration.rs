#[path = "reconcile_staging_integration.rs"]
mod cases;

#[tokio::test(flavor = "current_thread")]
async fn reconciliation_resumes_new_message_fetching_from_its_saved_cursor() {
    cases::keep_cases();
    cases::reconciliation_resumes_new_message_fetching_from_its_saved_cursor().await;
}
