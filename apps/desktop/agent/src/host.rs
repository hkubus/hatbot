//! The Mac app's side of the agent. The app starts `hatbot-agent` and writes it a line of JSON with
//! the brain, its token and the owner's switch, then a line for each change (the switch, pause, stop,
//! asking for macOS's permissions). The agent writes back a line of [`State`] whenever it changes.
//! Closing its stdin stops it. Its main thread runs the run loop macOS's calls want.

use std::io::{BufRead, Write};
use std::time::Duration;

use objc2_core_foundation::{CFRunLoop, CFRunLoopTimer, kCFRunLoopDefaultMode};
use serde::{Deserialize, Serialize};

use crate::macos::{Access, access, ask_access};
use crate::protocol::ComputerStatus;
use crate::{Agent, AgentConfig, AgentHandle, Connection};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    pub brain_url: String,
    pub token: String,
    pub enabled: bool,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Command {
    Enabled {
        on: bool,
    },
    Pause,
    Resume,
    StopTask,
    AskAccess,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// "connecting", "connected" or "offline".
    pub connection: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub status: ComputerStatus,
    /// macOS lets Hatbot control the computer (Accessibility).
    pub control: bool,
    /// macOS lets Hatbot see the screen (Screen Recording).
    pub screen: bool,
}

pub fn state(connection: &Connection, status: ComputerStatus, access: Access) -> State {
    let (connection, error) = match connection {
        Connection::Connecting => ("connecting", None),
        Connection::Connected => ("connected", None),
        Connection::Offline { error, .. } => ("offline", Some(error.clone())),
    };
    State { connection, error, status, control: access.control, screen: access.screen }
}

pub fn apply(agent: &AgentHandle, command: Command) {
    match command {
        Command::Enabled { on } => {
            if on {
                ask_access();
            }
            agent.set_enabled(on);
        }
        Command::Pause => agent.pause(),
        Command::Resume => agent.resume(),
        Command::StopTask => agent.stop_task(),
        Command::AskAccess => ask_access(),
        Command::Unknown => {}
    }
}

/// Runs the agent for the app, until its stdin closes.
pub fn run() -> ! {
    let stdin = std::io::stdin();
    let mut first = String::new();
    let start = match stdin.lock().read_line(&mut first).map(|_| serde_json::from_str::<Start>(&first)) {
        Ok(Ok(s)) => s,
        _ => {
            eprintln!("hatbot-agent: the app sends its settings as the first line.");
            std::process::exit(2);
        }
    };
    if start.enabled {
        ask_access();
    }
    let agent =
        Agent::start(AgentConfig { brain_url: start.brain_url, device_token: start.token, enabled: start.enabled });
    let (status, connection) = (agent.status(), agent.connection());
    std::thread::spawn(move || {
        let mut out = std::io::stdout();
        let mut last: Option<State> = None;
        loop {
            let now = state(&connection.borrow(), status.borrow().clone(), access());
            if last.as_ref() != Some(&now) {
                let line = serde_json::to_string(&now).expect("state serialises");
                if writeln!(out, "{line}").and_then(|_| out.flush()).is_err() {
                    std::process::exit(0);
                }
                last = Some(now);
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if let Ok(c) = serde_json::from_str::<Command>(&line) {
                apply(&agent, c);
            }
        }
        agent.shutdown();
        std::process::exit(0);
    });
    keep_main_run_loop();
}

/// A run loop with nothing in it returns at once; a timer that never fires keeps this one going.
fn keep_main_run_loop() -> ! {
    // SAFETY: a plain timer with no callout context, added to the current (main) thread's run loop.
    unsafe {
        let timer = CFRunLoopTimer::new(None, f64::MAX, 0.0, 0, 0, None, std::ptr::null_mut());
        if let Some(rl) = CFRunLoop::current() {
            rl.add_timer(timer.as_deref(), kCFRunLoopDefaultMode);
        }
    }
    loop {
        CFRunLoop::run();
        std::thread::sleep(Duration::from_millis(100));
    }
}
