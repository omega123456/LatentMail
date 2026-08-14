use latentmail_lib::{
    contacts,
    storage::{Account, AccountRepository, Storage},
};

#[test]
fn contacts_are_normalized_ranked_and_account_scoped() {
    let connection = Storage::in_memory().unwrap();
    for id in ["one", "two"] {
        AccountRepository::upsert(
            &connection,
            &Account {
                id: id.into(),
                email: format!("{id}@example.com"),
                display_name: id.into(),
                avatar_url: None,
                history_id: None,
                needs_reauthentication: false,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
    }
    contacts::observe(&connection, "one", "First Name <PERSON@Example.com>", 1).unwrap();
    contacts::observe(&connection, "one", "New Name <person@example.com>", 2).unwrap();
    contacts::observe(&connection, "two", "person@example.com", 3).unwrap();
    let one = contacts::lookup(&connection, "one", "pe").unwrap();
    assert_eq!(one[0].address, "person@example.com");
    assert_eq!(one[0].display_name.as_deref(), Some("New Name"));
    assert_eq!(one[0].frequency, 2);
    assert_eq!(
        contacts::lookup(&connection, "two", "pe").unwrap()[0].frequency,
        1
    );
}

#[test]
fn observe_now_wraps_observe_with_the_current_time() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "one".into(),
            email: "one@example.com".into(),
            display_name: "one".into(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    let before = chrono::Utc::now().timestamp();
    contacts::observe_now(&connection, "one", "Real Time <now@example.com>").unwrap();
    let after = chrono::Utc::now().timestamp();
    let observed = contacts::lookup(&connection, "one", "now").unwrap();
    assert_eq!(observed[0].address, "now@example.com");
    assert!((before..=after).contains(&observed[0].last_seen_at));
}

#[test]
fn observe_many_coalesces_repeated_addresses_without_losing_recency() {
    let connection = Storage::in_memory().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "one".into(),
            email: "one@example.com".into(),
            display_name: "one".into(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    contacts::observe_many(
        &connection,
        "one",
        &[
            ("Old Name <person@example.com>".into(), 1),
            ("New Name <PERSON@example.com>".into(), 2),
            ("person@example.com".into(), 3),
        ],
    )
    .unwrap();

    let contact = contacts::lookup(&connection, "one", "person").unwrap();
    assert_eq!(contact[0].frequency, 3);
    assert_eq!(contact[0].last_seen_at, 3);
    assert_eq!(contact[0].display_name.as_deref(), Some("New Name"));
}
