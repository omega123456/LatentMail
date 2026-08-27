use crate::reconcile_staging_integration as cases;

#[tokio::test(flavor = "current_thread")]
async fn resumed_reconciliation_matches_an_uninterrupted_universe_pass() {
    cases::keep_cases();
    cases::resumed_reconciliation_matches_an_uninterrupted_universe_pass().await;
}
