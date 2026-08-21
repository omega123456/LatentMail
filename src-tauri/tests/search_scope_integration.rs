use latentmail_lib::search::scope::{resolve, SearchScope};

#[test]
fn default_scope_excludes_trash_spam_and_drafts() {
    let filter = resolve(&SearchScope::Default);
    let mut excluded = filter.excluded_labels.clone();
    excluded.sort();
    assert_eq!(excluded, vec!["DRAFT", "SPAM", "TRASH"]);
    assert!(filter.required_label.is_none());
}

#[test]
fn all_scope_excludes_nothing() {
    let filter = resolve(&SearchScope::All);
    assert!(filter.excluded_labels.is_empty());
    assert!(filter.required_label.is_none());
}

#[test]
fn label_scope_narrows_to_a_single_label_and_excludes_nothing() {
    let filter = resolve(&SearchScope::Label {
        label_id: "Label_1".into(),
    });
    assert!(filter.excluded_labels.is_empty());
    assert_eq!(filter.required_label.as_deref(), Some("Label_1"));
}

#[test]
fn only_the_trash_and_spam_scopes_count_trashed_and_spammed_messages() {
    assert!(!resolve(&SearchScope::Default).includes_trashed_and_spammed());
    assert!(resolve(&SearchScope::All).includes_trashed_and_spammed());
    for label_id in ["TRASH", "SPAM"] {
        assert!(resolve(&SearchScope::Label {
            label_id: label_id.into(),
        })
        .includes_trashed_and_spammed());
    }
    assert!(!resolve(&SearchScope::Label {
        label_id: "INBOX".into(),
    })
    .includes_trashed_and_spammed());
}

#[test]
fn the_default_exclusion_rule_lives_only_here() {
    let default_filter = resolve(&SearchScope::Default);
    let all_filter = resolve(&SearchScope::All);
    assert_ne!(default_filter.excluded_labels, all_filter.excluded_labels);
}
