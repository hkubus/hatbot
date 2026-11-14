//! The real computer on Windows: GDI captures, SendInput, the window list, UI Automation, and a
//! thread of its own for what needs a window (the session lock, the owner's input, the clipboard).

mod clipboard;
mod input;
mod keymap;
mod screen;
mod session;
mod uia;
mod wins;

use tokio::sync::{mpsc, oneshot};

use crate::computer::{
    BoxFuture, Button, Clip, Computer, Fields, Frame, InspectAt, Output, Result, SessionEvent, Window,
};
use crate::keycode::KeyCode;
use crate::protocol::AgentElement;
use crate::typing::KeyTable;

pub struct WindowsComputer;

impl WindowsComputer {
    pub fn start() -> (Self, mpsc::UnboundedReceiver<SessionEvent>) {
        let (events, rx) = mpsc::unbounded_channel();
        session::start(events);
        (Self, rx)
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| format!("Hatbot's agent failed: {e}."))?
}

impl Computer for WindowsComputer {
    fn compositor(&self) -> String {
        "windows".into()
    }

    fn features(&self) -> Vec<String> {
        ["screen", "live", "input", "windows", "uia", "files", "shell", "teach"].map(String::from).to_vec()
    }

    fn focused_output(&self) -> BoxFuture<'_, Result<Output>> {
        Box::pin(blocking(|| Ok(screen::focused()?.output())))
    }

    fn capture(&self, output: String) -> BoxFuture<'_, Result<Frame>> {
        Box::pin(blocking(move || screen::capture(&screen::named(&output)?)))
    }

    fn pointer_to(&self, output: Output, x: f64, y: f64) -> BoxFuture<'_, Result<()>> {
        Box::pin(blocking(move || {
            let (px, py) = screen::named(&output.name)?.physical(x, y);
            input::move_to(px, py)
        }))
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
        Box::pin(blocking(keymap::table))
    }

    fn clipboard(&self) -> BoxFuture<'_, Result<Option<Clip>>> {
        Box::pin(async move { session::run(clipboard::read).await? })
    }

    fn set_clipboard(&self, clip: Option<Clip>) -> BoxFuture<'_, Result<oneshot::Receiver<()>>> {
        Box::pin(async move { session::run(move |h| clipboard::write(h, clip)).await? })
    }

    fn windows(&self, output: String) -> BoxFuture<'_, Result<Option<Vec<Window>>>> {
        Box::pin(blocking(move || Ok(Some(wins::list(&screen::named(&output)?)))))
    }

    fn focus_window(&self, id: u64) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { session::run(move |_| wins::focus(id)).await? })
    }

    fn inspect(&self, at: InspectAt) -> BoxFuture<'_, Result<Option<AgentElement>>> {
        Box::pin(uia::inspect(at))
    }

    fn fields(
        &self,
        pid: Option<i32>,
        _: Option<String>,
        field: bool,
        filled: bool,
    ) -> BoxFuture<'_, Result<Option<Fields>>> {
        Box::pin(uia::fields(pid, field, filled))
    }
}
