//! The agent that lets Hatbot use this computer. This is the client track's stand-in with the
//! agent's API; the real one dials the brain and drives the compositor.
pub mod protocol;

use tokio::sync::watch;

pub use protocol::Status;

#[derive(Debug, Clone)]
pub struct Config {
    /// The brain's address, as the app signed in to it.
    pub server: String,
    /// The app's device token.
    pub token: String,
    /// "Let Hatbot use this computer", as last set here.
    pub enabled: bool,
}

/// What the app shows of the agent.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentState {
    /// Connected to the brain.
    pub online: bool,
    pub status: Status,
    /// The task holding the screen, while one does.
    pub task: Option<String>,
}

pub struct Agent {
    state: watch::Sender<AgentState>,
}

impl Agent {
    pub fn start(config: Config) -> Handle {
        let (tx, rx) = watch::channel(AgentState {
            online: false,
            status: Status { enabled: config.enabled, ..Status::default() },
            task: None,
        });
        Handle { agent: std::sync::Arc::new(Agent { state: tx }), rx }
    }
}

#[derive(Clone)]
pub struct Handle {
    agent: std::sync::Arc<Agent>,
    rx: watch::Receiver<AgentState>,
}

impl Handle {
    pub fn state(&self) -> AgentState {
        self.rx.borrow().clone()
    }

    /// Changes as the agent's state does.
    pub fn watch(&self) -> watch::Receiver<AgentState> {
        self.rx.clone()
    }

    pub fn set_enabled(&self, on: bool) {
        self.agent.state.send_modify(|s| {
            s.status.enabled = on;
            if !on {
                s.task = None;
            }
        });
    }

    pub fn pause(&self) {
        self.agent.state.send_modify(|s| s.status.paused = true);
    }

    pub fn resume(&self) {
        self.agent.state.send_modify(|s| s.status.paused = false);
    }

    /// Lets go of the screen now: the Stop button on the banner.
    pub fn stop_task(&self) {
        self.agent.state.send_modify(|s| s.task = None);
    }

    pub fn shutdown(&self) {
        self.agent.state.send_modify(|s| s.online = false);
    }
}
