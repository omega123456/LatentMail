#[path = "reconcile_staging_integration.rs"]
mod cases;

#[tokio::test(flavor = "current_thread")]
async fn reconciliation_resumes_universe_enumeration_with_its_saved_candidate() {
    cases::keep_cases();
    cases::reconciliation_resumes_universe_enumeration_with_its_saved_candidate().await;
}
