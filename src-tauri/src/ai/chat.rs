use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};

use chrono::{Local, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::{
    ai::{
        credentials, prompts,
        provider::Provider,
        retrieval::{retrieve, HistoryMessage, Passage, Retrieval, RetrievalRequest, Role},
        AiService,
    },
    storage::{addresses, AccountRepository, PassageSource},
    sync::to_millis,
};

pub const QUESTION_LIMIT: usize = 2000;
pub const HISTORY_LIMIT: usize = 10;
pub const CHAT_EVENT: &str = "ai-chat://event";
pub const NO_RESULTS: &str =
    "I could not find anything in this account's indexed mail that answers that.";

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSource {
    pub number: usize,
    pub sender_name: String,
    pub sender_address: String,
    pub subject: String,
    pub sent_at_millis: i64,
    pub message_id: String,
    pub thread_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatEventKind {
    Started,
    Delta {
        text: String,
    },
    Sources {
        sources: Vec<ChatSource>,
        answer: String,
    },
    Done {
        cancelled: bool,
        error: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatEvent<'a> {
    request_id: &'a str,
    session_id: &'a str,
    account_id: &'a str,
    #[serde(flatten)]
    kind: ChatEventKind,
}

pub struct ChatRun {
    pub request_id: String,
    pub session_id: String,
    pub account_id: String,
    pub question: String,
    pub history: Vec<HistoryMessage>,
    pub cancel: Arc<AtomicBool>,
}

struct ActiveRequest {
    request_id: String,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
struct ChatState {
    active: Option<ActiveRequest>,
    session_id: String,
    history: Vec<HistoryMessage>,
}

#[derive(Clone, Default)]
pub struct ChatRegistry {
    state: Arc<Mutex<ChatState>>,
}

impl ChatRegistry {
    pub fn begin(
        &self,
        account_id: &str,
        session_id: &str,
        question: &str,
    ) -> Result<ChatRun, String> {
        let mut state = self.lock()?;
        if state.active.is_some() {
            return Err("A question is already being answered".to_owned());
        }
        if state.session_id != session_id {
            state.session_id = session_id.to_owned();
            state.history.clear();
        }
        let request_id = next_request_id();
        let cancel = Arc::new(AtomicBool::new(false));
        state.active = Some(ActiveRequest {
            request_id: request_id.clone(),
            cancel: cancel.clone(),
        });
        let history = trim(&state.history);
        Ok(ChatRun {
            request_id,
            session_id: session_id.to_owned(),
            account_id: account_id.to_owned(),
            question: question.to_owned(),
            history,
            cancel,
        })
    }
    pub fn cancel(&self, request_id: &str) -> Result<bool, String> {
        let mut state = self.lock()?;
        let matched = state
            .active
            .as_ref()
            .is_some_and(|active| active.request_id == request_id);
        if !matched {
            return Ok(false);
        }
        if let Some(active) = state.active.take() {
            active.cancel.store(true, Ordering::SeqCst);
        }
        Ok(true)
    }
    pub fn retire(&self, request_id: &str) -> Result<bool, String> {
        let mut state = self.lock()?;
        let matched = state
            .active
            .as_ref()
            .is_some_and(|active| active.request_id == request_id);
        if matched {
            state.active = None;
        }
        Ok(matched)
    }
    pub fn record(&self, session_id: &str, question: &str, answer: &str) -> Result<(), String> {
        let mut state = self.lock()?;
        if state.session_id != session_id {
            return Ok(());
        }
        state.history.push(HistoryMessage {
            role: Role::User,
            content: question.to_owned(),
        });
        state.history.push(HistoryMessage {
            role: Role::Assistant,
            content: answer.to_owned(),
        });
        Ok(())
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ChatState>, String> {
        self.state
            .lock()
            .map_err(|_| "AI chat registry lock poisoned".to_owned())
    }
}

fn next_request_id() -> String {
    format!(
        "chat-{}-{}",
        Utc::now().timestamp_millis(),
        REQUEST_COUNTER.fetch_add(1, Ordering::SeqCst)
    )
}

fn trim(history: &[HistoryMessage]) -> Vec<HistoryMessage> {
    history
        .iter()
        .skip(history.len().saturating_sub(HISTORY_LIMIT))
        .cloned()
        .collect()
}

pub fn validate_question(question: &str) -> Result<String, String> {
    let trimmed = question.trim();
    if trimmed.is_empty() {
        return Err("Ask a question first".to_owned());
    }
    if trimmed.chars().count() > QUESTION_LIMIT {
        return Err(format!(
            "Questions are limited to {QUESTION_LIMIT} characters"
        ));
    }
    Ok(trimmed.to_owned())
}

fn cite(
    marker: &str,
    passages: &[Passage],
    sources: &[PassageSource],
    cited: &mut Vec<i64>,
) -> Option<usize> {
    let number = marker.parse::<usize>().ok()?;
    let passage = passages.get(number.checked_sub(1)?)?;
    if !sources
        .iter()
        .any(|source| source.message_seq == passage.message_seq)
    {
        return None;
    }
    let position = cited
        .iter()
        .position(|sequence| *sequence == passage.message_seq)
        .unwrap_or_else(|| {
            cited.push(passage.message_seq);
            cited.len() - 1
        });
    Some(position + 1)
}

pub fn citations(
    answer: &str,
    passages: &[Passage],
    sources: &[PassageSource],
) -> (String, Vec<ChatSource>) {
    let mut cited: Vec<i64> = Vec::new();
    let mut rewritten = String::with_capacity(answer.len());
    let bytes = answer.as_bytes();
    let mut index = 0;
    let mut copied = 0;
    while index < bytes.len() {
        if bytes[index] == b'[' {
            let start = index + 1;
            let mut end = start;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end > start && bytes.get(end) == Some(&b']') {
                rewritten.push_str(&answer[copied..index]);
                match cite(&answer[start..end], passages, sources, &mut cited) {
                    Some(number) => rewritten.push_str(&format!("[{number}]")),
                    None => {
                        if rewritten.ends_with(' ') {
                            rewritten.pop();
                        }
                    }
                }
                index = end + 1;
                copied = index;
                continue;
            }
        }
        index += 1;
    }
    rewritten.push_str(&answer[copied..]);
    let cards = cited
        .into_iter()
        .filter_map(|sequence| sources.iter().find(|source| source.message_seq == sequence))
        .enumerate()
        .map(|(index, source)| {
            let identity = addresses::first_identity(&source.sender);
            ChatSource {
                number: index + 1,
                sender_name: identity
                    .as_ref()
                    .map_or_else(|| source.sender.clone(), |value| value.display.clone()),
                sender_address: identity
                    .as_ref()
                    .map_or_else(|| source.sender.clone(), |value| value.address.clone()),
                subject: source.subject.clone(),
                sent_at_millis: to_millis(source.sent_at),
                message_id: source.message_id.clone(),
                thread_id: source.thread_id.clone(),
            }
        })
        .collect();
    (rewritten, cards)
}

enum Answer {
    Cancelled,
    Complete {
        text: String,
        sources: Option<Vec<ChatSource>>,
    },
}

fn emit<R: Runtime>(app: &AppHandle<R>, request: &ChatRun, kind: ChatEventKind) {
    let _ = app.emit(
        CHAT_EVENT,
        ChatEvent {
            request_id: &request.request_id,
            session_id: &request.session_id,
            account_id: &request.account_id,
            kind,
        },
    );
}

fn history_json(history: &[HistoryMessage]) -> Vec<serde_json::Value> {
    history
        .iter()
        .map(
            |message| serde_json::json!({"role": message.role.label(), "content": message.content}),
        )
        .collect()
}

async fn account_email(service: &AiService, account_id: &str) -> Result<String, String> {
    let id = account_id.to_owned();
    service
        .storage()
        .run(move |connection| AccountRepository::get(connection, &id))
        .await
        .map_err(|error| error.to_string())?
        .map(|account| account.email)
        .ok_or_else(|| "Account does not exist".to_owned())
}

async fn produce<R: Runtime>(
    app: &AppHandle<R>,
    service: &AiService,
    request: &ChatRun,
) -> Result<Answer, String> {
    let config = service.config_for(&request.account_id).await?;
    let base_url = config
        .base_url
        .ok_or_else(|| "Save an API root first".to_owned())?;
    let chat_model = config
        .chat_model
        .ok_or_else(|| "Select a chat model first".to_owned())?;
    let embedding_model = config
        .embedding_model
        .ok_or_else(|| "Select an embedding model first".to_owned())?;
    let email = account_email(service, &request.account_id).await?;
    let provider = Provider::new(&base_url, credentials::load(&request.account_id)?)?;
    let retrieved = retrieve(
        &provider,
        &service.storage(),
        &RetrievalRequest {
            chat_model: &chat_model,
            embedding_model: &embedding_model,
            account_id: &request.account_id,
            account_email: &email,
            question: &request.question,
            history: &request.history,
        },
        &request.cancel,
    )
    .await?;
    let found = match retrieved {
        Retrieval::Cancelled => return Ok(Answer::Cancelled),
        Retrieval::Empty => {
            emit(
                app,
                request,
                ChatEventKind::Delta {
                    text: NO_RESULTS.to_owned(),
                },
            );
            return Ok(Answer::Complete {
                text: NO_RESULTS.to_owned(),
                sources: None,
            });
        }
        Retrieval::Found(found) => found,
    };
    let mut messages = vec![serde_json::json!({
        "role": "system",
        "content": prompts::system(Local::now(), &email),
    })];
    messages.extend(history_json(&request.history));
    messages.push(serde_json::json!({
        "role": "user",
        "content": format!(
            "## Email Context\n\n{}\n\n## Question\n\n{}",
            found.context, request.question
        ),
    }));
    let mut text = String::new();
    provider
        .chat_completion_stream(
            &chat_model,
            serde_json::Value::Array(messages),
            &request.cancel,
            &mut |delta| {
                text.push_str(delta);
                emit(
                    app,
                    request,
                    ChatEventKind::Delta {
                        text: delta.to_owned(),
                    },
                );
            },
        )
        .await
        .map_err(|error| error.to_string())?;
    if request.cancel.load(Ordering::SeqCst) {
        return Ok(Answer::Cancelled);
    }
    let (answer, sources) = citations(&text, &found.passages, &found.sources);
    Ok(Answer::Complete {
        text: answer,
        sources: Some(sources),
    })
}

pub async fn run<R: Runtime>(app: &AppHandle<R>, service: &AiService, request: ChatRun) {
    emit(app, &request, ChatEventKind::Started);
    let outcome = produce(app, service, &request).await;
    let terminal = match outcome {
        Ok(Answer::Cancelled) => ChatEventKind::Done {
            cancelled: true,
            error: None,
        },
        Ok(Answer::Complete { text, sources }) => {
            if let Some(sources) = sources {
                emit(
                    app,
                    &request,
                    ChatEventKind::Sources {
                        sources,
                        answer: text.clone(),
                    },
                );
            }
            let _ = service
                .chat()
                .record(&request.session_id, &request.question, &text);
            ChatEventKind::Done {
                cancelled: false,
                error: None,
            }
        }
        Err(error) => ChatEventKind::Done {
            cancelled: false,
            error: Some(error),
        },
    };
    emit(app, &request, terminal);
    let _ = service.chat().retire(&request.request_id);
}
