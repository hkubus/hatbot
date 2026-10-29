//! What the agent needs from the computer, behind one trait: Wayland, uinput, niri and AT-SPI on a real
//! one (`linux.rs`), fakes in tests.

use std::future::Future;
use std::pin::Pin;

use evdev::KeyCode;
use tokio::sync::oneshot;

use crate::protocol::AgentElement;
use crate::typing::KeyTable;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
/// Errors are plain sentences, for the brain.
pub type Result<T> = std::result::Result<T, String>;

/// A monitor, in logical pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct Output {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

/// A monitor's pixels as captured: RGB, in the buffer's own (physical) size.
#[derive(Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

impl Frame {
    /// Whether a part of it, in physical pixels, is solid black: how a window blacked out from
    /// capture by a niri rule looks.
    pub fn black(&self, x: u32, y: u32, width: u32, height: u32) -> bool {
        let x1 = (x + width).min(self.width);
        let y1 = (y + height).min(self.height);
        if x1 <= x + 8 || y1 <= y + 8 {
            return false;
        }
        let (mut black, mut all) = (0usize, 0usize);
        for py in (y..y1).step_by(3) {
            for px in (x..x1).step_by(3) {
                let i = (py as usize * self.width as usize + px as usize) * 3;
                all += 1;
                if self.rgb[i..i + 3] == [0, 0, 0] {
                    black += 1;
                }
            }
        }
        black * 1000 >= all * 998
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// A window, with where it is on a monitor in logical pixels when it's on it.
#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    pub id: u64,
    pub title: String,
    pub app_id: String,
    pub focused: bool,
    pub pid: Option<i32>,
    pub rect: Option<Rect>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

/// What a clipboard held: each type it offered, and its bytes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Clip(pub Vec<(String, Vec<u8>)>);

impl Clip {
    pub fn text(text: &str) -> Self {
        Self(
            ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING", "TEXT"]
                .iter()
                .map(|m| (m.to_string(), text.as_bytes().to_vec()))
                .collect(),
        )
    }
}

/// Where to look with AT-SPI: a point in a window (window-relative logical pixels), or the
/// keyboard focus.
#[derive(Debug, Clone, PartialEq)]
pub enum InspectAt {
    Point { pid: i32, title: String, x: f64, y: f64 },
    Focus { pid: Option<i32> },
}

/// What happens on the computer that changes the status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEvent {
    Locked(bool),
    /// Input after a second without any.
    Resumed,
    /// No input for a few seconds.
    Quiet,
}

pub trait Computer: Send + Sync + 'static {
    /// "niri", "sway" or another compositor's name.
    fn compositor(&self) -> String;
    /// What this copy can do, for the hello.
    fn features(&self) -> Vec<String>;
    fn focused_output(&self) -> BoxFuture<'_, Result<Output>>;
    /// The monitor's pixels, the pointer drawn in.
    fn capture(&self, output: String) -> BoxFuture<'_, Result<Frame>>;
    /// Puts the pointer at a point on a monitor, in its logical pixels.
    fn pointer_to(&self, output: Output, x: f64, y: f64) -> BoxFuture<'_, Result<()>>;
    fn button(&self, button: Button, down: bool) -> BoxFuture<'_, Result<()>>;
    /// Wheel clicks: positive is down or right.
    fn wheel(&self, dx: i32, dy: i32) -> BoxFuture<'_, Result<()>>;
    fn key(&self, code: KeyCode, down: bool) -> BoxFuture<'_, Result<()>>;
    /// The keymap in use, its current layout chosen.
    fn key_table(&self) -> BoxFuture<'_, Result<KeyTable>>;
    fn clipboard(&self) -> BoxFuture<'_, Result<Option<Clip>>>;
    /// Sets the clipboard (None empties it). The receiver fires once an app has read it.
    fn set_clipboard(&self, clip: Option<Clip>) -> BoxFuture<'_, Result<oneshot::Receiver<()>>>;
    /// The windows, placed on this monitor; None when the compositor can't list them.
    fn windows(&self, output: String) -> BoxFuture<'_, Result<Option<Vec<Window>>>>;
    fn focus_window(&self, id: u64) -> BoxFuture<'_, Result<()>>;
    /// The element there, from AT-SPI; None when there's no tree.
    fn inspect(&self, at: InspectAt) -> BoxFuture<'_, Result<Option<AgentElement>>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_a_blacked_out_window_from_a_dark_one() {
        let mut f = Frame { width: 100, height: 100, rgb: vec![0; 100 * 100 * 3] };
        assert!(f.black(10, 10, 50, 50));
        // A dark terminal still has a prompt.
        for y in 20..24 {
            for x in 20..30 {
                let i = (y * 100 + x) * 3;
                f.rgb[i..i + 3].copy_from_slice(&[200, 200, 200]);
            }
        }
        assert!(!f.black(10, 10, 50, 50));
    }
}
