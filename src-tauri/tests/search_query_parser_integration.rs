use chrono::{Months, TimeZone, Utc};
use latentmail_lib::search::query::{parse, PredicateKind, QueryError, MAX_QUERY_LENGTH};

fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 6, 15, 12, 0, 0).unwrap()
}

#[test]
fn blank_query_parses_to_no_query_without_error() {
    let parsed = parse("   ", now()).unwrap();
    assert!(parsed.is_empty());
    assert!(!parsed.has_text_term);
    assert!(parsed.match_expression.is_none());
    assert!(parsed.predicates.is_empty());
}

#[test]
fn a_query_over_the_length_cap_is_rejected_before_any_other_work() {
    let text = "a".repeat(MAX_QUERY_LENGTH + 1);
    let error = parse(&text, now()).unwrap_err();
    assert_eq!(error, QueryError::TooLong);
}

#[test]
fn a_query_at_exactly_the_length_cap_is_accepted() {
    let text = "a".repeat(MAX_QUERY_LENGTH);
    assert!(parse(&text, now()).is_ok());
}

#[test]
fn bare_terms_and_quoted_phrases_become_fts_match_terms() {
    let parsed = parse("quarterly \"final report\"", now()).unwrap();
    assert!(parsed.has_text_term);
    assert_eq!(parsed.includes, vec!["quarterly", "final report"]);
    assert_eq!(
        parsed.match_expression.as_deref(),
        Some("\"quarterly\" \"final report\"")
    );
}

#[test]
fn from_to_and_subject_operators_become_column_filters_and_populate_fields() {
    let parsed = parse("from:anna to:bob subject:invoice", now()).unwrap();
    assert_eq!(parsed.from.as_deref(), Some("anna"));
    assert_eq!(parsed.to.as_deref(), Some("bob"));
    assert_eq!(parsed.subject.as_deref(), Some("invoice"));
    assert!(parsed.has_text_term);
    assert_eq!(
        parsed.match_expression.as_deref(),
        Some("sender:\"anna\" recipients:\"bob\" subject:\"invoice\"")
    );
}

#[test]
fn operator_names_are_case_insensitive() {
    let lower = parse("from:anna", now()).unwrap();
    let upper = parse("FROM:anna", now()).unwrap();
    let mixed = parse("From:anna", now()).unwrap();
    assert_eq!(lower.from, upper.from);
    assert_eq!(lower.from, mixed.from);
}

#[test]
fn quoted_phrase_content_is_preserved_case_sensitively() {
    let parsed = parse("\"Quarterly Report\"", now()).unwrap();
    assert_eq!(parsed.includes, vec!["Quarterly Report"]);
}

#[test]
fn an_unrecognised_operator_token_is_treated_as_literal_text() {
    let parsed = parse("foo:bar", now()).unwrap();
    assert!(parsed.from.is_none());
    assert!(parsed.predicates.is_empty());
    assert_eq!(parsed.includes, vec!["foo:bar"]);
    assert_eq!(parsed.match_expression.as_deref(), Some("\"foo:bar\""));
}

#[test]
fn label_and_in_operators_become_structured_predicates_not_fts_terms() {
    let parsed = parse("label:receipts in:Clients", now()).unwrap();
    assert!(!parsed.has_text_term);
    assert!(parsed.match_expression.is_none());
    assert_eq!(
        parsed.predicates,
        vec![
            latentmail_lib::search::query::Predicate {
                kind: PredicateKind::Label("receipts".into()),
                negated: false,
            },
            latentmail_lib::search::query::Predicate {
                kind: PredicateKind::Label("Clients".into()),
                negated: false,
            },
        ]
    );
}

#[test]
fn negated_label_becomes_a_negated_predicate() {
    let parsed = parse("-label:receipts", now()).unwrap();
    assert_eq!(
        parsed.predicates,
        vec![latentmail_lib::search::query::Predicate {
            kind: PredicateKind::Label("receipts".into()),
            negated: true,
        }]
    );
}

#[test]
fn is_and_has_operators_produce_flag_predicates_with_no_text_term() {
    let parsed = parse("is:unread has:attachment", now()).unwrap();
    assert!(!parsed.has_text_term);
    assert_eq!(
        parsed.predicates,
        vec![
            latentmail_lib::search::query::Predicate {
                kind: PredicateKind::Unread,
                negated: false,
            },
            latentmail_lib::search::query::Predicate {
                kind: PredicateKind::HasAttachment,
                negated: false,
            },
        ]
    );
}

#[test]
fn is_read_is_the_negation_of_is_unread() {
    let read = parse("is:read", now()).unwrap();
    let negated_unread = parse("-is:unread", now()).unwrap();
    assert_eq!(read.predicates, negated_unread.predicates);
    assert_eq!(
        read.predicates,
        vec![latentmail_lib::search::query::Predicate {
            kind: PredicateKind::Unread,
            negated: true,
        }]
    );
}

#[test]
fn is_unstarred_is_the_negation_of_is_starred() {
    let unstarred = parse("is:unstarred", now()).unwrap();
    assert_eq!(
        unstarred.predicates,
        vec![latentmail_lib::search::query::Predicate {
            kind: PredicateKind::Starred,
            negated: true,
        }]
    );
}

#[test]
fn negated_has_attachment_requires_the_message_have_none() {
    let parsed = parse("-has:attachment", now()).unwrap();
    assert_eq!(
        parsed.predicates,
        vec![latentmail_lib::search::query::Predicate {
            kind: PredicateKind::HasAttachment,
            negated: true,
        }]
    );
}

#[test]
fn before_and_after_resolve_absolute_dates_through_chrono() {
    let parsed = parse("after:2026/01/15 before:2026-02-01", now()).unwrap();
    let expected_after = Utc.with_ymd_and_hms(2026, 1, 15, 0, 0, 0).unwrap().timestamp();
    let expected_before = Utc.with_ymd_and_hms(2026, 2, 1, 0, 0, 0).unwrap().timestamp();
    assert_eq!(
        parsed.predicates,
        vec![
            latentmail_lib::search::query::Predicate {
                kind: PredicateKind::SentAfter(expected_after),
                negated: false,
            },
            latentmail_lib::search::query::Predicate {
                kind: PredicateKind::SentBefore(expected_before),
                negated: false,
            },
        ]
    );
}

#[test]
fn newer_than_two_months_means_two_calendar_months_not_minutes() {
    let parsed = parse("newer_than:2m", now()).unwrap();
    let expected = now().checked_sub_months(Months::new(2)).unwrap().timestamp();
    assert_eq!(
        parsed.predicates,
        vec![latentmail_lib::search::query::Predicate {
            kind: PredicateKind::SentAfter(expected),
            negated: false,
        }]
    );
}

#[test]
fn older_than_thirty_days_resolves_through_chrono_duration() {
    let parsed = parse("older_than:30d", now()).unwrap();
    let expected = (now() - chrono::Duration::days(30)).timestamp();
    assert_eq!(
        parsed.predicates,
        vec![latentmail_lib::search::query::Predicate {
            kind: PredicateKind::SentBefore(expected),
            negated: false,
        }]
    );
}

#[test]
fn newer_than_one_year_means_twelve_calendar_months() {
    let parsed = parse("newer_than:1y", now()).unwrap();
    let expected = now().checked_sub_months(Months::new(12)).unwrap().timestamp();
    assert_eq!(
        parsed.predicates,
        vec![latentmail_lib::search::query::Predicate {
            kind: PredicateKind::SentAfter(expected),
            negated: false,
        }]
    );
}

#[test]
fn an_unparseable_duration_falls_back_to_literal_text() {
    let parsed = parse("newer_than:soon", now()).unwrap();
    assert!(parsed.predicates.is_empty());
    assert_eq!(parsed.includes, vec!["newer_than:soon"]);
}

#[test]
fn a_query_of_only_structured_operators_has_no_text_term() {
    let parsed = parse("is:unread has:attachment label:receipts", now()).unwrap();
    assert!(!parsed.has_text_term);
    assert!(parsed.match_expression.is_none());
    assert_eq!(parsed.predicates.len(), 3);
}

#[test]
fn a_second_from_operator_overflows_into_the_free_text_fields() {
    let parsed = parse("from:anna from:ben", now()).unwrap();
    assert_eq!(parsed.from.as_deref(), Some("anna"));
    assert_eq!(parsed.includes, vec!["ben"]);
    assert_eq!(
        parsed.match_expression.as_deref(),
        Some("sender:\"anna\" sender:\"ben\"")
    );
}

#[test]
fn a_negated_bare_word_alongside_a_positive_term_is_excluded_via_fts_not() {
    let parsed = parse("quarterly -draft", now()).unwrap();
    assert_eq!(parsed.includes, vec!["quarterly"]);
    assert_eq!(parsed.excludes, vec!["draft"]);
    assert_eq!(
        parsed.match_expression.as_deref(),
        Some("\"quarterly\" NOT (\"draft\")")
    );
}

#[test]
fn a_lone_negated_bare_word_with_no_positive_anchor_falls_back_to_a_structured_predicate() {
    let parsed = parse("-spam", now()).unwrap();
    assert!(!parsed.has_text_term);
    assert!(parsed.match_expression.is_none());
    assert_eq!(parsed.excludes, vec!["spam"]);
    assert_eq!(parsed.predicates.len(), 1);
    assert!(matches!(
        parsed.predicates[0].kind,
        PredicateKind::TextExcludes(_)
    ));
}

#[test]
fn quoted_operator_values_may_contain_spaces() {
    let parsed = parse("subject:\"quarterly report\"", now()).unwrap();
    assert_eq!(parsed.subject.as_deref(), Some("quarterly report"));
    assert_eq!(
        parsed.match_expression.as_deref(),
        Some("subject:\"quarterly report\"")
    );
}
