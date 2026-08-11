use latentmail_lib::{
    queue::{recover_durable_operations, OperationKind},
    storage::{Account, AccountRepository, Operation, OperationRepository, Storage},
};

#[test]
fn only_send_and_draft_operations_are_durable() {
    assert!(OperationKind::Send.persists());
    assert!(OperationKind::Draft.persists());
    assert!(!OperationKind::Noop.persists());
    assert!(!OperationKind::LabelMutation.persists());
}

#[test]
fn restart_recovers_queued_durable_work_and_marks_active_send_uncertain() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "mail@example.com".into(),
            display_name: "Mail".into(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    for (id, kind, status) in [
        ("queued-send", "send", "queued"),
        ("active-send", "send", "active"),
        ("queued-draft", "draft", "queued"),
        ("label", "label", "queued"),
    ] {
        OperationRepository::upsert(
            &connection,
            &Operation {
                id: id.into(),
                account_id: "account".into(),
                lane: "interactive".into(),
                kind: kind.into(),
                entity_key: id.into(),
                payload: "{}".into(),
                status: status.into(),
                attempts: 0,
                next_attempt_at: None,
                error: None,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
    }
    let recovered = recover_durable_operations(&connection).unwrap();
    assert_eq!(
        recovered
            .iter()
            .map(|operation| operation.id.as_str())
            .collect::<Vec<_>>(),
        ["queued-send", "queued-draft"]
    );
    let interrupted = OperationRepository::get(&connection, "active-send")
        .unwrap()
        .unwrap();
    assert_eq!(interrupted.status, "failed");
    assert_eq!(
        interrupted.error.as_deref(),
        Some("May have been sent; retry manually")
    );
}
