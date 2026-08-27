use crate::reconcile_staging_integration as cases;

#[test]
fn membership_diff_reports_every_divergent_label_set() {
    cases::keep_cases();
    cases::membership_diff_reports_every_divergent_label_set();
}
