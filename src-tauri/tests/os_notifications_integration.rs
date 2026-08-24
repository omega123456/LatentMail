use latentmail_lib::{
    os::{
        initialize,
        notifications::{click_intent, content, NotificationController},
    },
    settings::SettingsService,
    storage::Storage,
    sync::MailArrival,
};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Listener, Manager};

#[test]
fn notification_content_names_one_arrival_or_summarizes_a_batch() {
    let first = MailArrival {
        thread_id: "thread-1".into(),
        sender: "Alex <alex@example.com>".into(),
        subject: "Hello".into(),
        snippet: "A short preview".into(),
    };
    assert_eq!(
        content(std::slice::from_ref(&first)),
        Some(("Alex".into(), "Hello\nA short preview".into()))
    );
    assert_eq!(
        content(&[
            MailArrival {
                subject: String::new(),
                ..first.clone()
            },
            MailArrival {
                thread_id: "thread-2".into(),
                sender: "Bea <bea@example.com>".into(),
                subject: "Later".into(),
                snippet: "Another preview".into(),
            },
        ]),
        Some((
            "Alex".into(),
            "(No subject)\nA short preview — and 1 more".into(),
        ))
    );
    assert_eq!(
        content(&[MailArrival {
            sender: "alex@example.com".into(),
            snippet: String::new(),
            ..first.clone()
        }]),
        Some(("alex@example.com".into(), "Hello".into()))
    );
    assert_eq!(content(&[]), None);
    assert_eq!(
        content(&[MailArrival {
            sender: String::new(),
            ..first.clone()
        }]),
        Some(("(No sender)".into(), "Hello\nA short preview".into()))
    );
}

#[tokio::test]
async fn notification_fake_batches_arrivals_honours_the_preference_and_emits_click_intents() {
    let directory = tempfile::tempdir().unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(SettingsService::new(
        Storage::open(directory.path().join("mail.sqlite")).unwrap(),
    ));
    initialize(app.handle()).unwrap();
    let arrival = MailArrival {
        thread_id: "thread-1".into(),
        sender: "Alex <alex@example.com>".into(),
        subject: "Hello".into(),
        snippet: "A short preview".into(),
    };
    for index in 0..5 {
        app.emit(
            "mail://new",
            latentmail_lib::sync::NewMailEvent {
                account_id: "account-1".into(),
                thread_ids: vec![format!("thread-{index}")],
                arrivals: vec![MailArrival {
                    thread_id: format!("thread-{index}"),
                    ..arrival.clone()
                }],
            },
        )
        .unwrap();
    }
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    assert_eq!(
        app.state::<NotificationController>()
            .pending_count("account-1")
            .await,
        5
    );
    NotificationController::fire_batch_timer(app.handle(), "account-1".into()).await;
    tokio::task::yield_now().await;
    let records = app.state::<NotificationController>().records().await;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].account_id, "account-1");
    assert_eq!(records[0].arrivals.len(), 5);
    app.state::<SettingsService>()
        .write("desktopNotifications".into(), serde_json::json!(false))
        .await
        .unwrap();
    app.emit(
        "mail://new",
        latentmail_lib::sync::NewMailEvent {
            account_id: "account-2".into(),
            thread_ids: vec![arrival.thread_id.clone()],
            arrivals: vec![arrival],
        },
    )
    .unwrap();
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    assert_eq!(
        app.state::<NotificationController>()
            .pending_count("account-2")
            .await,
        1
    );
    NotificationController::fire_batch_timer(app.handle(), "account-2".into()).await;
    assert_eq!(
        app.state::<NotificationController>().records().await.len(),
        1
    );
    let intents = Arc::new(Mutex::new(Vec::new()));
    let received = Arc::clone(&intents);
    app.listen("os://intent", move |event| {
        received.lock().unwrap().push(event.payload().to_owned())
    });
    NotificationController::click(app.handle(), "account-1".into(), Some("thread-1".into()));
    assert!(intents.lock().unwrap()[0].contains("openThread"));
    assert!(intents.lock().unwrap()[0].contains("thread-1"));
}

#[test]
fn notification_click_destinations_are_thread_or_folder_scoped() {
    let arrivals = [
        MailArrival {
            thread_id: "thread-1".into(),
            sender: "Alex <alex@example.com>".into(),
            subject: "Hello".into(),
            snippet: "A short preview".into(),
        },
        MailArrival {
            thread_id: "thread-2".into(),
            sender: "Bea <bea@example.com>".into(),
            subject: "Later".into(),
            snippet: "Another preview".into(),
        },
    ];
    assert_eq!(arrivals.len(), 2);
    assert_eq!(
        click_intent("account-1".into(), Some("thread-1".into())),
        serde_json::json!({ "kind": "openThread", "accountId": "account-1", "threadId": "thread-1" })
    );
    assert_eq!(
        click_intent("account-1".into(), None),
        serde_json::json!({ "kind": "openFolder", "accountId": "account-1" })
    );
}
