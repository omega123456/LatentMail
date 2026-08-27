use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use latentmail_lib::{
    gmail::{backoff, GmailClient},
    sync::concurrency::{fan_out, fetch_messages, FanOutError, MESSAGE_FETCH_CONCURRENCY},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Barrier,
};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

struct PendingDrop(Arc<AtomicUsize>);

impl Drop for PendingDrop {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn bounded_fan_out_caps_work_and_cancels_after_a_terminal_error() {
    let started = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    let barrier = Arc::new(Barrier::new(MESSAGE_FETCH_CONCURRENCY));
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        fan_out((0..16).collect(), MESSAGE_FETCH_CONCURRENCY, {
            let started = Arc::clone(&started);
            let dropped = Arc::clone(&dropped);
            let barrier = Arc::clone(&barrier);
            move |id| {
                let started = Arc::clone(&started);
                let dropped = Arc::clone(&dropped);
                let barrier = Arc::clone(&barrier);
                async move {
                    started.fetch_add(1, Ordering::SeqCst);
                    barrier.wait().await;
                    if id == 0 {
                        return Err("terminal");
                    }
                    let _pending = PendingDrop(dropped);
                    std::future::pending::<Result<usize, &str>>().await
                }
            }
        }),
    )
    .await
    .unwrap();

    assert!(matches!(result, Err(FanOutError::Work("terminal"))));
    assert_eq!(started.load(Ordering::SeqCst), MESSAGE_FETCH_CONCURRENCY);
    tokio::time::timeout(Duration::from_secs(1), async {
        while dropped.load(Ordering::SeqCst) < MESSAGE_FETCH_CONCURRENCY - 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_retryable_message_error_completes_the_batch() {
    let server = MockServer::start().await;
    let message = serde_json::json!({
        "id": "m1", "threadId": "t1", "historyId": "1", "labelIds": ["INBOX"],
        "snippet": "message", "internalDate": "1000", "payload": { "headers": [] }
    });
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(ResponseTemplate::new(500).insert_header("connection", "close"))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("connection", "close")
                .set_body_json(message),
        )
        .mount(&server)
        .await;

    let client = GmailClient::with_base_url("token", server.uri());
    let pending = fetch_messages(&client, vec!["m1".into()]);
    tokio::pin!(pending);
    tokio::task::yield_now().await;
    tokio::time::advance(backoff(1)).await;

    assert_eq!(pending.await.unwrap().len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn gmail_clients_share_one_connection_pool() {
    let (base_url, connections, server) = connection_counter().await;
    let first = GmailClient::with_base_url("token", &base_url);
    let second = GmailClient::with_base_url("token", base_url);

    assert_eq!(first.profile().await.unwrap().history_id, 1);
    assert_eq!(second.profile().await.unwrap().history_id, 1);
    assert_eq!(connections.load(Ordering::SeqCst), 1);

    server.abort();
}

async fn connection_counter() -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let connections = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&connections);
    let server = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            count.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(reply_to_profiles(stream));
        }
    });
    (format!("http://{address}"), connections, server)
}

async fn reply_to_profiles(mut stream: TcpStream) {
    let body =
        r#"{"emailAddress":"me@example.com","messagesTotal":0,"threadsTotal":0,"historyId":"1"}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: keep-alive\r\n\r\n{}",
        body.len(),
        body
    );
    let mut bytes = Vec::new();
    let mut buffer = [0; 1024];
    for _ in 0..2 {
        let Ok(read) = stream.read(&mut buffer).await else {
            return;
        };
        if read == 0 {
            return;
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            if stream.write_all(response.as_bytes()).await.is_err() {
                return;
            }
            bytes.clear();
        }
    }
}
