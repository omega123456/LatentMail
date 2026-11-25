use std::sync::Arc;

use latentmail_lib::{
    queue::{Executor, QueueEventSink, QueueOperation},
    storage::{Account, HtmlPresence, Message, Storage},
    sync::{noop_event_sink, SyncEngine, SyncEngineDeps, WorkRegistry},
};
use tokio::sync::{mpsc, oneshot};

pub fn app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock tauri app builds")
}

pub fn events_channel() -> (
    QueueEventSink,
    mpsc::UnboundedReceiver<(&'static str, serde_json::Value)>,
) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let sink: QueueEventSink = Arc::new(move |event, payload| {
        let _ = sender.send((event, payload));
    });
    (sink, receiver)
}

pub async fn wait_for_item_status(
    receiver: &mut mpsc::UnboundedReceiver<(&'static str, serde_json::Value)>,
    id: &str,
    status: &str,
) {
    loop {
        let (event, payload) = receiver.recv().await.expect("event stream stays open");
        if event == latentmail_lib::events::QUEUE_ITEM
            && payload["id"] == id
            && payload["status"] == status
        {
            return;
        }
    }
}

pub fn controllable_executor() -> (
    Executor,
    mpsc::UnboundedReceiver<(String, oneshot::Sender<()>)>,
) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let executor: Executor = Arc::new(move |operation: QueueOperation| {
        let sender = sender.clone();
        Box::pin(async move {
            let (release_sender, release_receiver) = oneshot::channel();
            let _ = sender.send((operation.id, release_sender));
            let _ = release_receiver.await;
            Ok(())
        })
    });
    (executor, receiver)
}

pub fn sync_engine(storage: &Storage) -> Arc<SyncEngine> {
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    SyncEngine::new(SyncEngineDeps {
        storage: storage.clone(),
        queue: queue,
        registry: registry,
        events: noop_event_sink(),
    })
}

pub fn account(id: &str, email: &str, display_name: &str) -> Account {
    Account {
        id: id.to_owned(),
        email: email.to_owned(),
        display_name: display_name.to_owned(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}

pub fn message(account_id: &str, id: &str, thread_id: &str) -> Message {
    Message {
        account_id: account_id.to_owned(),
        id: id.to_owned(),
        thread_id: thread_id.to_owned(),
        rfc_message_id: None,
        sender: "sender@example.com".to_owned(),
        recipients: String::new(),
        subject: "Subject".to_owned(),
        sent_at: 1,
        snippet: "snippet".to_owned(),
        html_body: None,
        plain_body: None,
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id: 1,
        truncated_body: None,
        html_presence: HtmlPresence::Present,
    }
}
