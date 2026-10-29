// What reaches the app from outside its windows: the tray, notifications, a second launch, the agent.
use std::sync::{Mutex, OnceLock};

use futures::StreamExt;
use futures::channel::mpsc;
use futures::stream::BoxStream;
use iced::Subscription;

#[derive(Debug, Clone)]
pub enum Outside {
    /// Open the window: the tray, a notification's body, or `hatbot` run again.
    Open,
    /// `hatbot --open <page>`.
    Show(String),
    Notice {
        key: String,
        action: String,
    },
    Pause(bool),
    /// Stop what Hatbot is doing on this computer: the banner's or the tray's Stop.
    StopComputer,
    Quit,
    Agent(AgentState),
}

type Pair = (mpsc::UnboundedSender<Outside>, Mutex<Option<mpsc::UnboundedReceiver<Outside>>>);

static INBOX: OnceLock<Pair> = OnceLock::new();

fn pair() -> &'static Pair {
    INBOX.get_or_init(|| {
        let (tx, rx) = mpsc::unbounded();
        (tx, Mutex::new(Some(rx)))
    })
}

pub fn send(o: Outside) {
    let _ = pair().0.unbounded_send(o);
}

fn stream() -> BoxStream<'static, Outside> {
    match pair().1.lock().unwrap().take() {
        Some(rx) => rx.boxed(),
        None => futures::stream::pending().boxed(),
    }
}

pub fn subscription() -> Subscription<Outside> {
    Subscription::run(stream)
}

/// What the app shows of the agent.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentState {
    /// Connected to the brain.
    pub online: bool,
    pub status: hatbot_agent::protocol::ComputerStatus,
}

impl AgentState {
    /// A task holds the screen.
    pub fn using(&self) -> bool {
        self.status.screen.is_some()
    }
}
