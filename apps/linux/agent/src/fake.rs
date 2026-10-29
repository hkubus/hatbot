//! A computer for tests: one 1600x1000 monitor, a US-and-Czech keymap, and a log of the input it got.

use std::sync::Mutex;

use evdev::KeyCode;
use tokio::sync::oneshot;

use crate::computer::{
    BoxFuture, Button, Clip, Computer, Frame, InspectAt, Output, Result, Window,
};
use crate::protocol::AgentElement;
use crate::typing::KeyTable;

#[derive(Debug, Clone, PartialEq)]
pub enum Call {
    Pointer(f64, f64),
    Button(Button, bool),
    Wheel(i32, i32),
    Key(KeyCode, bool),
    SetClipboard(Option<Clip>),
    FocusWindow(u64),
}

pub struct Fake {
    pub calls: Mutex<Vec<Call>>,
    pub windows: Mutex<Option<Vec<Window>>>,
    pub frame: Mutex<Frame>,
    pub clipboard: Mutex<Option<Clip>>,
}

pub const OUTPUT: (u32, u32) = (1600, 1000);

impl Fake {
    pub fn new() -> Self {
        Self {
            calls: Mutex::new(vec![]),
            windows: Mutex::new(None),
            frame: Mutex::new(Frame {
                width: OUTPUT.0,
                height: OUTPUT.1,
                rgb: vec![200; (OUTPUT.0 * OUTPUT.1 * 3) as usize],
            }),
            clipboard: Mutex::new(None),
        }
    }

    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    fn log(&self, c: Call) -> Result<()> {
        self.calls.lock().unwrap().push(c);
        Ok(())
    }
}

impl Computer for Fake {
    fn compositor(&self) -> String {
        "niri".into()
    }

    fn features(&self) -> Vec<String> {
        vec!["screen".into(), "input".into(), "windows".into()]
    }

    fn focused_output(&self) -> BoxFuture<'_, Result<Output>> {
        Box::pin(async {
            Ok(Output { name: "DP-1".into(), width: OUTPUT.0, height: OUTPUT.1, scale: 1.0 })
        })
    }

    fn capture(&self, _: String) -> BoxFuture<'_, Result<Frame>> {
        Box::pin(async { Ok(self.frame.lock().unwrap().clone()) })
    }

    fn pointer_to(&self, _: Output, x: f64, y: f64) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.log(Call::Pointer(x, y)) })
    }

    fn button(&self, b: Button, down: bool) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.log(Call::Button(b, down)) })
    }

    fn wheel(&self, dx: i32, dy: i32) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.log(Call::Wheel(dx, dy)) })
    }

    fn key(&self, code: KeyCode, down: bool) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.log(Call::Key(code, down)) })
    }

    fn key_table(&self) -> BoxFuture<'_, Result<KeyTable>> {
        Box::pin(async { Ok(crate::typing::tests::table()) })
    }

    fn clipboard(&self) -> BoxFuture<'_, Result<Option<Clip>>> {
        Box::pin(async { Ok(self.clipboard.lock().unwrap().clone()) })
    }

    fn set_clipboard(&self, clip: Option<Clip>) -> BoxFuture<'_, Result<oneshot::Receiver<()>>> {
        Box::pin(async move {
            self.log(Call::SetClipboard(clip.clone()))?;
            *self.clipboard.lock().unwrap() = clip;
            // Read at once, as an app pasting would.
            let (tx, rx) = oneshot::channel();
            let _ = tx.send(());
            Ok(rx)
        })
    }

    fn windows(&self, _: String) -> BoxFuture<'_, Result<Option<Vec<Window>>>> {
        Box::pin(async { Ok(self.windows.lock().unwrap().clone()) })
    }

    fn focus_window(&self, id: u64) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.log(Call::FocusWindow(id)) })
    }

    fn inspect(&self, _: InspectAt) -> BoxFuture<'_, Result<Option<AgentElement>>> {
        Box::pin(async { Ok(None) })
    }
}
