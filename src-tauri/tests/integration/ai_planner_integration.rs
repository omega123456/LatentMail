use std::sync::{Arc, Mutex};

use chrono::{Local, NaiveDate, TimeZone};
use latentmail_lib::{
    ai::{
        planner::{self, RetrievalPlan},
        prompts,
        provider::Provider,
        retrieval::{HistoryMessage, Passage, RetrievalRequest, Role},
    },
    storage::RetrievalFilters,
};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, Request, Respond, ResponseTemplate,
};

fn seconds(day: &str, hour: u32) -> i64 {
    Local
        .from_local_datetime(
            &NaiveDate::parse_from_str(day, "%Y-%m-%d")
                .unwrap()
                .and_hms_opt(hour, 0, 0)
                .unwrap(),
        )
        .earliest()
        .unwrap()
        .timestamp()
}

fn day_start(day: &str) -> i64 {
    seconds(day, 0)
}

fn day_end(day: &str) -> i64 {
    Local
        .from_local_datetime(
            &NaiveDate::parse_from_str(day, "%Y-%m-%d")
                .unwrap()
                .and_hms_opt(23, 59, 59)
                .unwrap(),
        )
        .latest()
        .unwrap()
        .timestamp()
}

struct Recorder {
    bodies: Arc<Mutex<Vec<serde_json::Value>>>,
    content: String,
}

impl Respond for Recorder {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        self.bodies
            .lock()
            .unwrap()
            .push(serde_json::from_slice(&request.body).unwrap());
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{"message": {"content": self.content.clone()}}]
        }))
    }
}

fn request<'a>(question: &'a str, history: &'a [HistoryMessage]) -> RetrievalRequest<'a> {
    RetrievalRequest {
        chat_model: "chat",
        embedding_model: "embedding",
        account_id: "account",
        account_email: "me@example.com",
        question,
        history,
    }
}

async fn planner_server(content: &str) -> (MockServer, Arc<Mutex<Vec<serde_json::Value>>>) {
    let server = MockServer::start().await;
    let bodies: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(Recorder {
            bodies: bodies.clone(),
            content: content.to_owned(),
        })
        .mount(&server)
        .await;
    (server, bodies)
}

fn provider(server: &MockServer) -> Provider {
    Provider::new(&format!("{}/v1", server.uri()), Some("secret".into())).unwrap()
}

#[test]
fn the_planner_response_maps_onto_every_structured_filter() {
    let plan = planner::parse(
        r#"{"dateFrom":"2026-03-01","dateTo":"2026-03-05","sender":"alice@example.com","recipient":"me@example.com","folder":"Inbox","hasAttachment":true,"isRead":"false","isStarred":true,"dateOrder":"asc"}"#,
    );
    assert!(plan.ascending);
    assert_eq!(
        plan.filters,
        RetrievalFilters {
            date_from: Some(day_start("2026-03-01")),
            date_to: Some(day_end("2026-03-05")),
            sender: Some("alice@example.com".into()),
            recipient: Some("me@example.com".into()),
            folder: Some("Inbox".into()),
            has_attachment: Some(true),
            is_read: Some(false),
            is_starred: Some(true),
        }
    );
}

#[test]
fn an_unusable_planner_response_yields_empty_constraints() {
    for raw in [
        "not json",
        "\"a string\"",
        "7",
        "[]",
        "{\"dateOrder\":\"desc\"}",
    ] {
        assert_eq!(planner::parse(raw), RetrievalPlan::default());
    }
    let wrapped = planner::parse(r#"[{"folder":"  ","sender":"Ada","hasAttachment":"maybe"}]"#);
    assert_eq!(wrapped.filters.sender, Some("Ada".into()));
    assert_eq!(wrapped.filters.folder, None);
    assert_eq!(wrapped.filters.has_attachment, None);
    let malformed = planner::parse(r#"{"dateFrom":"not-a-date","isRead":"TRUE"}"#);
    assert_eq!(malformed.filters.date_from, None);
    assert_eq!(malformed.filters.is_read, Some(true));
}

#[tokio::test]
async fn the_planner_call_carries_the_schema_the_sampling_controls_and_the_conversation() {
    let (server, bodies) = planner_server(r#"{"sender":"Dropbox","dateOrder":"asc"}"#).await;
    let history = vec![
        HistoryMessage {
            role: Role::User,
            content: "what was the latest from Dropbox".into(),
        },
        HistoryMessage {
            role: Role::Assistant,
            content: "A file sharing notification".into(),
        },
    ];
    let plan = planner::plan(
        &provider(&server),
        &request("when was the first one?", &history),
        &["Inbox".to_owned(), "Sent".to_owned()],
    )
    .await;
    assert!(plan.ascending);
    assert_eq!(plan.filters.sender, Some("Dropbox".into()));

    let recorded = bodies.lock().unwrap();
    assert_eq!(recorded.len(), 1);
    let body = &recorded[0];
    assert_eq!(body["temperature"], 0.0);
    assert_eq!(body["seed"], 20_260_827);
    assert_eq!(body["max_tokens"], 2048);
    assert_eq!(body["stream"], false);
    assert_eq!(body["response_format"], planner::response_format());
    assert_eq!(
        body["response_format"]["json_schema"]["name"],
        "retrieval_plan"
    );
    let system = body["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains("Available folders: Inbox, Sent"));
    assert!(!system.contains("{{"));
    let user = body["messages"][1]["content"].as_str().unwrap();
    assert!(user.starts_with("Conversation:\nUser: what was the latest from Dropbox"));
    assert!(user.contains("Assistant: A file sharing notification"));
    assert!(user.ends_with("New question: when was the first one?"));
}

#[tokio::test]
async fn an_empty_conversation_is_labelled_and_a_transport_failure_plans_nothing() {
    let (server, bodies) = planner_server("{}").await;
    let plan = planner::plan(&provider(&server), &request("hello", &[]), &[]).await;
    assert_eq!(plan, RetrievalPlan::default());
    assert!(bodies.lock().unwrap()[0]["messages"][1]["content"]
        .as_str()
        .unwrap()
        .starts_with("Conversation: (empty)\nNew question: hello"));

    let broken = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&broken)
        .await;
    assert_eq!(
        planner::plan(&provider(&broken), &request("hello", &[]), &[]).await,
        RetrievalPlan::default()
    );
}

#[test]
fn the_prompts_carry_their_placeholders_and_the_numbered_passage_block() {
    let now = Local
        .from_local_datetime(
            &NaiveDate::from_ymd_opt(2026, 8, 26)
                .unwrap()
                .and_hms_opt(14, 30, 0)
                .unwrap(),
        )
        .earliest()
        .unwrap();
    let system = prompts::system(now, "me@example.com");
    assert!(system.contains("Wednesday, August 26, 2026, 2:30 PM"));
    assert!(system.contains("me@example.com"));
    assert!(!system.contains("{{"));
    let plan = prompts::plan(now, "me@example.com", &["Inbox".into(), "Sent".into()]);
    assert!(plan.contains("Today's date: 2026-08-26"));
    assert!(plan.contains("Available folders: Inbox, Sent"));
    assert!(plan.contains("dateOrder decision table"));
    assert!(!plan.contains("{{"));
    let block = prompts::passage_block(&[
        Passage {
            message_seq: 1,
            chunk_index: 0,
            similarity: 0.9,
            sent_at: seconds("2026-08-26", 14),
            sender: "Alice <alice@example.com>".into(),
            recipients: "me@example.com".into(),
            subject: "Budget".into(),
            text: "first passage".into(),
        },
        Passage {
            message_seq: 2,
            chunk_index: 1,
            similarity: 0.8,
            sent_at: seconds("2026-08-26", 15),
            sender: "Bob <bob@example.com>".into(),
            recipients: "me@example.com".into(),
            subject: "Venue".into(),
            text: "second passage".into(),
        },
    ]);
    assert!(block.starts_with("[1] From: Alice <alice@example.com>\nTo: me@example.com\nSubject: Budget\nDate: Wednesday, August 26, 2026, 2:00 PM\nfirst passage"));
    assert!(block.contains("\n\n---\n\n[2] From: Bob <bob@example.com>"));
    assert!(block.ends_with("second passage"));
    assert!(prompts::passage_block(&[]).is_empty());
}
