use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use chrono::Duration;

use crate::queue::QueueEngine;

pub type ResumeWork = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PowerSignal {
    Suspend,
    Resume,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExitDecision {
    Exit,
    Confirm { count: usize, message: String },
}

pub struct Lifecycle {
    queue: Arc<QueueEngine>,
    settling_delay: Duration,
    resume_work: ResumeWork,
    close_confirmed: AtomicBool,
}

impl Lifecycle {
    pub fn new(queue: Arc<QueueEngine>, settling_delay: Duration, resume_work: ResumeWork) -> Self {
        Self {
            queue,
            settling_delay,
            resume_work,
            close_confirmed: AtomicBool::new(false),
        }
    }

    pub async fn handle(&self, signal: PowerSignal) {
        match signal {
            PowerSignal::Suspend => {
                tracing::info!(target: "power", "system is going to sleep, suspending the queue");
                self.queue.set_suspended(true);
            }
            PowerSignal::Resume => {
                let Ok(delay) = self.settling_delay.to_std() else {
                    return;
                };
                tracing::info!(
                    target: "power",
                    "system woke up, waiting {}s for the network to settle",
                    self.settling_delay.num_seconds()
                );
                tokio::time::sleep(delay).await;
                tracing::info!(target: "power", "resuming the queue after wake");
                self.queue.set_suspended(false);
                if !self.queue.summary().paused {
                    (self.resume_work)().await;
                }
            }
        }
    }

    pub fn exit_decision(&self, restart: bool) -> ExitDecision {
        let count = self.queue.executing_sends();
        if restart || count == 0 || self.close_confirmed.load(Ordering::Acquire) {
            ExitDecision::Exit
        } else {
            let noun = if count == 1 {
                "message is"
            } else {
                "messages are"
            };
            ExitDecision::Confirm {
                count,
                message: format!("{count} {noun} still sending. Close anyway?"),
            }
        }
    }

    pub fn confirm_close(&self) {
        self.close_confirmed.store(true, Ordering::Release);
    }
}

pub fn settling_delay() -> Duration {
    if cfg!(target_os = "macos") {
        Duration::seconds(7)
    } else {
        Duration::seconds(15)
    }
}
