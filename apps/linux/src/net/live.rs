// Frames come one JPEG per binary message on /desktop/live. While you have control, your mouse,
// wheel and keys go back as text (`LiveInput` in packages/shared).
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use gtk::glib;
use serde::Serialize;

use super::api::Api;
use super::socket::{Frame, Socket};

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Input {
    Move {
        x: f64,
        y: f64,
    },
    Button {
        button: u8,
        down: bool,
        x: f64,
        y: f64,
    },
    Wheel {
        dy: f64,
        dx: f64,
        x: f64,
        y: f64,
    },
    Key {
        key: String,
        down: bool,
    },
}

/// One move per 50 ms at most, as the web and iOS apps send.
const MOVE_EVERY_US: i64 = 50_000;
/// Wheel deltas add up for this long and go as one message, so a fast spin isn't a flood.
const WHEEL_WINDOW: Duration = Duration::from_millis(100);

#[derive(Clone)]
pub struct Live(Rc<Inner>);

struct Inner {
    socket: Socket,
    /// The keys and buttons that are down, oldest first.
    held: RefCell<Vec<Held>>,
    point: Cell<(f64, f64)>,
    last_move: Cell<i64>,
    wheel: Cell<Option<(f64, f64)>>,
}

#[derive(PartialEq)]
enum Held {
    Key(String),
    Button(u8),
}

impl Live {
    pub fn new(api: &Api) -> Live {
        Live(Rc::new(Inner {
            socket: Socket::new(api, "/desktop/live", 15),
            held: RefCell::default(),
            point: Cell::new((0.0, 0.0)),
            last_move: Cell::new(0),
            wheel: Cell::new(None),
        }))
    }

    /// Each frame is a whole JPEG.
    pub fn on_frame(&self, f: impl Fn(glib::Bytes) + 'static) {
        self.0.socket.on_frame(move |frame| {
            if let Frame::Binary(bytes) = frame {
                f(bytes);
            }
        });
    }

    /// `true` with the first frame, `false` when the socket closes.
    pub fn on_connected(&self, f: impl Fn(bool) + 'static) {
        let f = Rc::new(f);
        let opened = f.clone();
        self.0.socket.on_open(move |_| opened(true));
        let weak = Rc::downgrade(&self.0);
        self.0.socket.on_close(move |()| {
            // The desktop lets go of what a viewer held when it goes.
            if let Some(i) = weak.upgrade() {
                i.held.borrow_mut().clear();
            }
            f(false);
        });
    }

    pub fn start(&self) {
        self.0.socket.start();
    }

    pub fn stop(&self) {
        self.release_all();
        self.0.socket.stop();
    }

    pub fn pointer_move(&self, x: f64, y: f64) {
        self.0.point.set((x, y));
        let now = glib::monotonic_time();
        if now - self.0.last_move.get() < MOVE_EVERY_US {
            return;
        }
        self.0.last_move.set(now);
        self.send(&Input::Move { x, y });
    }

    /// 1 is the left button, 2 the middle and 3 the right, as in X and GDK.
    pub fn button(&self, button: u8, down: bool, x: f64, y: f64) {
        self.0.point.set((x, y));
        if self.track(Held::Button(button), down) {
            self.send(&Input::Button { button, down, x, y });
        }
    }

    /// `key` is a character, or a key's name (`Return`, `Control_L`) as X or the browser names it.
    pub fn key(&self, key: &str, down: bool) {
        if self.track(Held::Key(key.into()), down) {
            self.send(&Input::Key {
                key: key.into(),
                down,
            });
        }
    }

    /// In the browser's units: 50 is one notch, and a positive `dy` scrolls down.
    pub fn wheel(&self, dx: f64, dy: f64, x: f64, y: f64) {
        self.0.point.set((x, y));
        if let Some((ax, ay)) = self.0.wheel.get() {
            self.0.wheel.set(Some((ax + dx, ay + dy)));
            return;
        }
        self.0.wheel.set(Some((dx, dy)));
        let weak = Rc::downgrade(&self.0);
        glib::spawn_future_local(async move {
            glib::timeout_future(WHEEL_WINDOW).await;
            let Some(i) = weak.upgrade() else { return };
            if let Some((dx, dy)) = i.wheel.take() {
                let (x, y) = i.point.get();
                Live(i).send(&Input::Wheel { dy, dx, x, y });
            }
        });
    }

    /// Lets go of every key and button still down, newest first: before handing back, and when
    /// the view loses focus or goes away, since their ups would never come.
    pub fn release_all(&self) {
        let held = self.0.held.take();
        let (x, y) = self.0.point.get();
        for h in held.into_iter().rev() {
            self.send(&match h {
                Held::Key(key) => Input::Key { key, down: false },
                Held::Button(button) => Input::Button {
                    button,
                    down: false,
                    x,
                    y,
                },
            });
        }
    }

    /// Whether this input should go: an up only for what's down, since the view may have let go of
    /// it already.
    fn track(&self, h: Held, down: bool) -> bool {
        let mut held = self.0.held.borrow_mut();
        let at = held.iter().position(|x| *x == h);
        match (down, at) {
            (true, None) => held.push(h),
            (true, Some(_)) => {}
            (false, Some(at)) => {
                held.remove(at);
            }
            (false, None) => return false,
        }
        true
    }

    fn send(&self, input: &Input) {
        if let Ok(text) = serde_json::to_string(input) {
            self.0.socket.send(&text);
        }
    }
}
