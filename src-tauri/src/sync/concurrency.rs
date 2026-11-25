use std::future::Future;
use std::sync::Arc;

use tokio::sync::Semaphore;
use tokio::task::{JoinError, JoinSet};

use crate::gmail::{GmailClient, GmailMessage};

use super::SyncError;

pub const MESSAGE_FETCH_CONCURRENCY: usize = 8;

pub enum FanOutError<E> {
    Work(E),
    Join(JoinError),
}

struct FanOutPool<U, E, F> {
    tasks: JoinSet<Result<U, E>>,
    permits: Arc<Semaphore>,
    work: F,
}

impl<U, E, F> FanOutPool<U, E, F>
where
    U: Send + 'static,
    E: Send + 'static,
{
    fn new(width: usize, work: F) -> Self {
        Self {
            tasks: JoinSet::new(),
            permits: Arc::new(Semaphore::new(width)),
            work: work,
        }
    }

    async fn spawn<T, Fut>(&mut self, item: T)
    where
        T: Send + 'static,
        F: Fn(T) -> Fut + Clone + Send + 'static,
        Fut: Future<Output = Result<U, E>> + Send + 'static,
    {
        let permit = Arc::clone(&self.permits).acquire_owned().await.unwrap();
        let operation = self.work.clone();
        self.tasks.spawn(async move {
            let _permit = permit;
            operation(item).await
        });
    }
}

pub async fn fan_out<T, U, E, F, Fut>(
    items: Vec<T>,
    width: usize,
    work: F,
) -> Result<Vec<U>, FanOutError<E>>
where
    T: Send + 'static,
    U: Send + 'static,
    E: Send + 'static,
    F: Fn(T) -> Fut + Clone + Send + 'static,
    Fut: Future<Output = Result<U, E>> + Send + 'static,
{
    assert!(width > 0);
    let mut items = items.into_iter();
    let mut pool = FanOutPool::new(width, work);
    let mut results = Vec::new();

    for item in items.by_ref().take(width) {
        pool.spawn(item).await;
    }

    while let Some(result) = pool.tasks.join_next().await {
        match result {
            Ok(Ok(value)) => results.push(value),
            Ok(Err(error)) => return Err(FanOutError::Work(error)),
            Err(error) => return Err(FanOutError::Join(error)),
        }
        if let Some(item) = items.next() {
            pool.spawn(item).await;
        }
    }

    Ok(results)
}

pub async fn fetch_messages(
    client: &GmailClient,
    ids: Vec<String>,
) -> Result<Vec<GmailMessage>, SyncError> {
    let client = client.clone();
    let results = fan_out(ids, MESSAGE_FETCH_CONCURRENCY, move |id| {
        let client = client.clone();
        async move { client.message_if_present(&id).await }
    })
    .await
    .map_err(|error| match error {
        FanOutError::Work(error) => SyncError::Gmail(error),
        FanOutError::Join(error) => SyncError::Failed(error.to_string()),
    })?;
    Ok(results.into_iter().flatten().collect())
}
