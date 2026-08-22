#[path = "reconcile_staging_integration.rs"]
mod cases;

#[tokio::test(flavor = "current_thread")]
async fn reconciliation_resumes_label_enumeration_from_its_saved_page() {
    cases::keep_cases();
    cases::reconciliation_resumes_label_enumeration_from_its_saved_page().await;
}
