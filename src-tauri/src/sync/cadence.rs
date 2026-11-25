use std::{future::Future, sync::Arc, time::Duration};

use tauri::{AppHandle, Runtime};
use tokio::sync::watch;

use super::engine::SyncEngine;
use crate::sync::commands;
use crate::{auth::AuthService, gmail::GmailClient};

pub struct SyncScheduler {
    pub(super) interval_sender: watch::Sender<Duration>,
}

impl SyncScheduler {
    pub fn start<F, Fut>(initial_interval: Duration, run_immediately: bool, tick: F) -> Arc<Self>
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let (sender, receiver) = watch::channel(initial_interval);
        tokio::spawn(run_scheduler_loop(receiver, run_immediately, tick));
        Arc::new(Self {
            interval_sender: sender,
        })
    }

    pub fn set_interval(&self, interval: Duration) {
        let _ = self.interval_sender.send(interval);
    }

    pub fn interval(&self) -> Duration {
        *self.interval_sender.borrow()
    }
}

async fn run_scheduler_loop<F, Fut>(
    mut receiver: watch::Receiver<Duration>,
    run_immediately: bool,
    tick: F,
) where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    if run_immediately {
        tick().await;
    }
    loop {
        wait_until_tick_due(&mut receiver).await;
        tick().await;
    }
}

async fn wait_until_tick_due(receiver: &mut watch::Receiver<Duration>) {
    while !wait_for_next_tick(receiver).await {}
}

async fn wait_for_next_tick(receiver: &mut watch::Receiver<Duration>) -> bool {
    let wait = *receiver.borrow();
    tokio::select! {
        _ = tokio::time::sleep(wait) => true,
        _ = receiver.changed() => false,
    }
}

pub const FAST_PROBE_INTERVAL_SECS: u64 = 30;

#[derive(Clone)]
pub struct SyncSchedulers {
    pub fast: Arc<SyncScheduler>,
    pub periodic: Arc<SyncScheduler>,
}

pub(super) struct CadenceServices<'a, R: Runtime> {
    pub(super) app: &'a AppHandle<R>,
    pub(super) auth: &'a AuthService,
    pub(super) engine: &'a Arc<SyncEngine>,
}

pub(super) async fn for_each_cadence_account<R, Action, Output>(
    services: CadenceServices<'_, R>,
    mut action: Action,
) where
    R: Runtime,
    Action: FnMut(String, GmailClient) -> Output,
    Output: std::future::Future<Output = ()>,
{
    if services.engine.queue.suspended() {
        return;
    }
    let Ok(accounts) = services.auth.accounts().await else {
        return;
    };
    for account in accounts {
        if services.engine.queue.suspended() || account.needs_reauthentication {
            continue;
        }
        let Ok(client) = commands::gmail_client_for(
            commands::GmailClientDeps {
                app: services.app,
                auth: services.auth,
                engine: services.engine,
            },
            &account.id,
        )
        .await
        else {
            continue;
        };
        if services.engine.queue.suspended() {
            continue;
        }
        action(account.id, client).await;
    }
}

pub async fn run_fast_cadence<R: Runtime>(
    app: &AppHandle<R>,
    auth: &AuthService,
    engine: &Arc<SyncEngine>,
) {
    for_each_cadence_account(
        CadenceServices {
            app: app,
            auth: auth,
            engine: engine,
        },
        |account_id, client| async move {
            let _ = engine.probe_only(&account_id, client).await;
        },
    )
    .await;
}

pub async fn run_periodic_cadence<R: Runtime>(
    app: &AppHandle<R>,
    auth: &AuthService,
    engine: &Arc<SyncEngine>,
) {
    for_each_cadence_account(
        CadenceServices {
            app: app,
            auth: auth,
            engine: engine,
        },
        |account_id, client| async move {
            if engine.run_sync(&account_id, client.clone()).await.is_ok() {
                engine.enqueue_backfill(&account_id, client).await;
                return;
            }
            auth.invalidate_access_token(&account_id);
        },
    )
    .await;
}
