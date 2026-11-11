//! The real computer on a Mac: ScreenCaptureKit captures, CGEvent input, the window list, the
//! Accessibility tree, and the main thread for what macOS wants there (keyboard layouts, the
//! pasteboard). The process's main thread has to run its run loop: `host` does.

mod ax;
mod clipboard;
mod input;
mod keymap;
mod screen;
mod session;
mod wins;

use dispatch2::DispatchQueue;
use objc2_core_graphics::{
    CGPreflightPostEventAccess, CGPreflightScreenCaptureAccess, CGRequestPostEventAccess, CGRequestScreenCaptureAccess,
};
use tokio::sync::{mpsc, oneshot};

use crate::computer::{BoxFuture, Button, Clip, Computer, Frame, InspectAt, Output, Result, SessionEvent, Window};
use crate::keycode::KeyCode;
use crate::protocol::AgentElement;
use crate::typing::KeyTable;

pub struct MacComputer;

impl MacComputer {
    pub fn start() -> (Self, mpsc::UnboundedReceiver<SessionEvent>) {
        let (events, rx) = mpsc::unbounded_channel();
        session::start(events);
        (Self, rx)
    }
}

/// What macOS lets Hatbot do: control the computer (Accessibility), and see the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Access {
    pub control: bool,
    pub screen: bool,
}

pub fn access() -> Access {
    Access { control: CGPreflightPostEventAccess() && ax::trusted(), screen: CGPreflightScreenCaptureAccess() }
}

/// Asks for what's missing; macOS shows its prompt once, and after that only System Settings can.
pub fn ask_access() {
    let now = access();
    if !now.control {
        CGRequestPostEventAccess();
    }
    if !now.screen {
        CGRequestScreenCaptureAccess();
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| format!("Hatbot's agent failed: {e}."))?
}

/// Runs `f` on the main thread.
async fn on_main<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    let (tx, rx) = oneshot::channel();
    DispatchQueue::main().exec_async(move || {
        let _ = tx.send(f());
    });
    rx.await.map_err(|_| "Hatbot's agent lost its main thread.".to_string())?
}

impl Computer for MacComputer {
    fn compositor(&self) -> String {
        "macos".into()
    }

    fn features(&self) -> Vec<String> {
        ["screen", "live", "input", "windows", "ax", "files", "shell"].map(String::from).to_vec()
    }

    fn focused_output(&self) -> BoxFuture<'_, Result<Output>> {
        Box::pin(blocking(|| Ok(screen::focused()?.output())))
    }

    fn capture(&self, output: String) -> BoxFuture<'_, Result<Frame>> {
        Box::pin(blocking(move || screen::capture(&screen::named(&output)?)))
    }

    fn pointer_to(&self, output: Output, x: f64, y: f64) -> BoxFuture<'_, Result<()>> {
        Box::pin(blocking(move || input::move_to(screen::named(&output.name)?.global(x, y))))
    }

    fn button(&self, button: Button, down: bool) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { input::button(button, down) })
    }

    fn wheel(&self, dx: i32, dy: i32) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { input::wheel(dx, dy) })
    }

    fn key(&self, code: KeyCode, down: bool) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { input::key(code, down) })
    }

    fn key_table(&self) -> BoxFuture<'_, Result<KeyTable>> {
        Box::pin(on_main(keymap::table))
    }

    fn clipboard(&self) -> BoxFuture<'_, Result<Option<Clip>>> {
        Box::pin(on_main(clipboard::read))
    }

    fn set_clipboard(&self, clip: Option<Clip>) -> BoxFuture<'_, Result<oneshot::Receiver<()>>> {
        Box::pin(on_main(move || clipboard::write(clip)))
    }

    fn windows(&self, output: String) -> BoxFuture<'_, Result<Option<Vec<Window>>>> {
        Box::pin(blocking(move || Ok(Some(wins::list(&screen::named(&output)?)))))
    }

    fn focus_window(&self, id: u64) -> BoxFuture<'_, Result<()>> {
        Box::pin(blocking(move || wins::focus(id)))
    }

    fn inspect(&self, at: InspectAt) -> BoxFuture<'_, Result<Option<AgentElement>>> {
        Box::pin(ax::inspect(at))
    }

    fn shortcut_key(&self) -> KeyCode {
        KeyCode::KEY_LEFTMETA
    }
}
