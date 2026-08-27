use latentmail_lib::{
    queue::{
        admit_durable, recover_durable_operations, recovered_queue_operation, Lane, OperationKind,
        QueueEngine, QueueOperation,
    },
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
        ("active-send-2", "send", "active"),
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
    let (recovered, uncertain_accounts) = recover_durable_operations(&connection).unwrap();
    assert_eq!(uncertain_accounts, ["account"]);
    assert_eq!(
        recovered_queue_operation(&recovered[1]).unwrap().kind,
        OperationKind::Draft
    );
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
    assert_eq!(
        OperationRepository::get(&connection, "active-send-2")
            .unwrap()
            .unwrap()
            .status,
        "failed"
    );
}

#[test]
fn a_draft_interrupted_mid_execution_is_requeued_rather_than_dropped() {
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
    OperationRepository::upsert(
        &connection,
        &Operation {
            id: "active-draft".into(),
            account_id: "account".into(),
            lane: "interactive".into(),
            kind: "draft".into(),
            entity_key: "active-draft".into(),
            payload: "{}".into(),
            status: "active".into(),
            attempts: 0,
            next_attempt_at: None,
            error: None,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    let (recovered, uncertain_accounts) = recover_durable_operations(&connection).unwrap();
    assert!(uncertain_accounts.is_empty());
    assert_eq!(recovered[0].id, "active-draft");
    assert_eq!(recovered[0].status, "queued");
}

#[tokio::test]
async fn admit_durable_persists_before_enqueue_and_terminal_state_is_recorded() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
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
    drop(connection);

    let engine = QueueEngine::new(
        250,
        250,
        std::sync::Arc::new(|_| Box::pin(async { Ok(()) })),
    );
    admit_durable(
        &engine,
        &storage,
        QueueOperation {
            id: "draft-1".into(),
            account_id: "account".into(),
            lane: Lane::Interactive,
            kind: OperationKind::Draft,
            entity_key: "draft:draft-1".into(),
            cost: 0,
            attempts: 0,
            description: "test operation".into(),
        },
        "{\"mode\":\"create\"}".into(),
    )
    .await
    .unwrap();

    let persisted = storage
        .run(|connection| OperationRepository::get(connection, "draft-1"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted.status, "queued");
    assert_eq!(persisted.payload, "{\"mode\":\"create\"}");

    storage
        .run(|connection| OperationRepository::mark_active(connection, "draft-1"))
        .await
        .unwrap();
    assert_eq!(
        storage
            .run(|connection| OperationRepository::get(connection, "draft-1"))
            .await
            .unwrap()
            .unwrap()
            .status,
        "active"
    );

    storage
        .run(|connection| OperationRepository::mark_terminal(connection, "draft-1", "done", None))
        .await
        .unwrap();
    assert_eq!(
        storage
            .run(|connection| OperationRepository::get(connection, "draft-1"))
            .await
            .unwrap()
            .unwrap()
            .status,
        "done"
    );

    storage
        .run(|connection| OperationRepository::remove(connection, "draft-1"))
        .await
        .unwrap();
    assert!(storage
        .run(|connection| OperationRepository::get(connection, "draft-1"))
        .await
        .unwrap()
        .is_none());
}

#[test]
fn uncertain_send_event_names_the_account() {
    let event = latentmail_lib::queue::uncertain_send_event("account");
    assert_eq!(
        serde_json::to_value(event).unwrap(),
        serde_json::json!({ "accountId": "account" })
    );
}

#[test]
fn recovered_queue_operation_rebuilds_send_work_and_ignores_other_kinds() {
    let send = Operation {
        id: "send-1".into(),
        account_id: "account".into(),
        lane: "background".into(),
        kind: "send".into(),
        entity_key: "draft:d1".into(),
        payload: "{}".into(),
        status: "queued".into(),
        attempts: 2,
        next_attempt_at: None,
        error: None,
        created_at: 1,
        updated_at: 1,
    };
    let rebuilt = recovered_queue_operation(&send).unwrap();
    assert_eq!(rebuilt.kind, OperationKind::Send);
    assert_eq!(rebuilt.lane, Lane::Background);
    assert_eq!(rebuilt.attempts, 2);
    assert!(recovered_queue_operation(&Operation {
        kind: "label".into(),
        ..send
    })
    .is_none());
}
