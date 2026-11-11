//! The agent for the Mac app, which starts it and talks to it over stdin and stdout (`host`). On
//! Linux and Windows the desktop app runs the agent itself.

#[cfg(target_os = "macos")]
fn main() {
    hatbot_agent::host::run()
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("hatbot-agent is the Mac app's: on Linux and Windows the desktop app runs the agent.");
    std::process::exit(1);
}
