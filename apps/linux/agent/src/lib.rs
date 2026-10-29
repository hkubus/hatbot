//! Lets Hatbot use the owner's Linux computer. The Linux app starts an [`Agent`], which dials out to the
//! brain and does what it asks on the screen, within what the owner allows: the switch, a pause, and
//! never while they're at the keyboard or the session is locked.

mod activity;
pub mod computer;
mod connection;
mod core;
#[cfg(test)]
mod e2e;
#[cfg(test)]
mod fake;
mod files;
mod human;
mod keys;
mod linux;
pub mod protocol;
mod scale;
mod shell;
mod typing;

use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, watch};

use crate::computer::{Computer, SessionEvent};
use crate::core::Core;
use crate::protocol::{ComputerStatus, Hello, PROTOCOL};

#[derive(Debug, Clone)]
pub struct AgentConfig {
    /// The brain's address, "https://hatbot.example".
    pub brain_url: String,
    /// The Linux app's device token.
    pub device_token: String,
    /// "Let Hatbot use this computer", as the owner last left it.
    pub enabled: bool,
}

/// The socket to the brain, for the app to show.
#[derive(Debug, Clone, PartialEq)]
pub enum Connection {
    Connecting,
    Connected,
    /// It dropped or couldn't be made, and why; another try comes after `retry_in`.
    Offline {
        error: String,
        retry_in: Duration,
    },
}

pub struct Agent;

impl Agent {
    /// Starts the agent on this computer, on a thread of its own.
    pub fn start(config: AgentConfig) -> AgentHandle {
        let rt = runtime();
        let (computer, events) = {
            let _rt = rt.enter();
            linux::LinuxComputer::start()
        };
        Self::run(rt, config, Arc::new(computer), events)
    }

    /// Starts it on another [`Computer`] (a fake, in tests).
    pub fn start_with(
        config: AgentConfig,
        computer: Arc<dyn Computer>,
        events: mpsc::UnboundedReceiver<SessionEvent>,
    ) -> AgentHandle {
        Self::run(runtime(), config, computer, events)
    }

    fn run(
        rt: tokio::runtime::Runtime,
        config: AgentConfig,
        computer: Arc<dyn Computer>,
        mut events: mpsc::UnboundedReceiver<SessionEvent>,
    ) -> AgentHandle {
        let core = Arc::new(Core::new(computer.clone(), config.enabled));
        let (conn_tx, connection) = watch::channel(Connection::Connecting);
        let (stop, stopped) = watch::channel(false);
        let watcher = core.clone();
        rt.spawn(async move {
            while let Some(ev) = events.recv().await {
                watcher.session_event(ev);
            }
        });
        let machine_id = machine_id();
        let name = host_name();
        let hello = move |enabled| Hello {
            protocol: PROTOCOL,
            machine_id: machine_id.clone(),
            name: name.clone(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            compositor: computer.compositor(),
            enabled,
            features: computer.features(),
        };
        let runner = core.clone();
        let thread = std::thread::Builder::new()
            .name("hatbot-agent".into())
            .spawn(move || rt.block_on(connection::run(config, runner, hello, conn_tx, stopped)))
            .expect("starting the agent's thread");
        AgentHandle { core, connection, stop, thread: Some(thread) }
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("hatbot-agent-rt")
        .enable_all()
        .build()
        .expect("starting the agent's runtime")
}

/// The running agent. Dropping it stops it.
pub struct AgentHandle {
    core: Arc<Core>,
    connection: watch::Receiver<Connection>,
    stop: watch::Sender<bool>,
    thread: Option<JoinHandle<()>>,
}

impl AgentHandle {
    /// The computer's status, as the brain sees it, whenever it changes.
    pub fn status(&self) -> watch::Receiver<ComputerStatus> {
        self.core.subscribe()
    }

    pub fn connection(&self) -> watch::Receiver<Connection> {
        self.connection.clone()
    }

    /// The owner's switch. Off, the brain may ask nothing but the status, and a task's claim ends.
    pub fn set_enabled(&self, on: bool) {
        self.core.set_enabled(on);
    }

    pub fn pause(&self) {
        self.core.set_paused(true);
    }

    pub fn resume(&self) {
        self.core.set_paused(false);
    }

    /// Takes the screen back from the task using it.
    pub fn stop_task(&self) {
        self.core.drop_claim();
    }

    /// Stops it and waits for its thread.
    pub fn shutdown(mut self) {
        self.stop_now();
    }

    fn stop_now(&mut self) {
        self.stop.send_replace(true);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for AgentHandle {
    fn drop(&mut self) {
        self.stop_now();
    }
}

/// Stable per machine, without giving out /etc/machine-id itself.
fn machine_id() -> String {
    let raw = std::fs::read_to_string("/etc/machine-id").unwrap_or_else(|_| host_name());
    let digest = Sha256::digest(format!("hatbot:{}", raw.trim()));
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

fn host_name() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|h| h.trim().to_owned())
        .ok()
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "Linux computer".into())
}
