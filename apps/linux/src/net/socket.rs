// A WebSocket to the brain that reconnects with backoff until it's stopped (Socket.swift on iOS).
use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};

use futures_channel::oneshot;
use gtk::glib;
use soup::prelude::*;

use super::api::Api;

pub enum Frame {
    Text(String),
    Binary(glib::Bytes),
}

type Callback<T> = RefCell<Option<Box<dyn Fn(T)>>>;

#[derive(Clone)]
pub struct Socket(Rc<Inner>);

struct Inner {
    api: Api,
    path: String,
    max_delay: u32,
    session: soup::Session,
    conn: RefCell<Option<soup::WebsocketConnection>>,
    run: RefCell<Option<glib::JoinHandle<()>>>,
    /// Kept across stop and start: opening again is a reconnect, so what was missed gets loaded.
    ever_opened: Cell<bool>,
    /// The first message counts as open: the event stream always starts with `paused`, the live
    /// view with a frame.
    on_open: Callback<bool>,
    on_frame: Callback<Frame>,
    on_close: Callback<()>,
}

impl Socket {
    pub fn new(api: &Api, path: &str, max_delay: u32) -> Socket {
        Socket(Rc::new(Inner {
            api: api.clone(),
            path: path.into(),
            max_delay,
            session: soup::Session::new(),
            conn: RefCell::new(None),
            run: RefCell::new(None),
            ever_opened: Cell::new(false),
            on_open: RefCell::new(None),
            on_frame: RefCell::new(None),
            on_close: RefCell::new(None),
        }))
    }

    /// `reconnected`: this open isn't the first.
    pub fn on_open(&self, f: impl Fn(bool) + 'static) {
        self.0.on_open.replace(Some(Box::new(f)));
    }

    pub fn on_frame(&self, f: impl Fn(Frame) + 'static) {
        self.0.on_frame.replace(Some(Box::new(f)));
    }

    pub fn on_close(&self, f: impl Fn(()) + 'static) {
        self.0.on_close.replace(Some(Box::new(f)));
    }

    pub fn running(&self) -> bool {
        self.0.run.borrow().is_some()
    }

    pub fn start(&self) {
        if self.running() {
            return;
        }
        let weak = Rc::downgrade(&self.0);
        self.0
            .run
            .replace(Some(glib::spawn_future_local(run(weak))));
    }

    pub fn stop(&self) {
        if let Some(run) = self.0.run.take() {
            run.abort();
        }
        if let Some(conn) = self.0.conn.take() {
            conn.close(1000, None);
        }
    }

    pub fn send(&self, text: &str) {
        if let Some(conn) = self.0.conn.borrow().as_ref()
            && conn.state() == soup::WebsocketState::Open
        {
            conn.send_text(text);
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            conn.close(1000, None);
        }
    }
}

async fn run(weak: Weak<Inner>) {
    let mut retry = 0u32;
    loop {
        let Some(s) = weak.upgrade() else { return };
        let msg = s.api.message("GET", &s.api.ws_url(&s.path));
        let connecting =
            s.session
                .websocket_connect_async_future(&msg, None, &[], glib::Priority::DEFAULT);
        let max_delay = s.max_delay;
        drop(s);
        let mut open = false;
        match connecting.await {
            Ok(conn) => {
                let Some(s) = weak.upgrade() else { return };
                // Proxies drop idle sockets, and a dead one only shows when a ping goes unanswered.
                conn.set_keepalive_interval(25);
                conn.set_keepalive_pong_timeout(10);
                // Screenshots and long messages are bigger than libsoup's 128 KB default.
                conn.set_max_incoming_payload_size(64 * 1024 * 1024);
                let (opened_tx, opened_rx) = oneshot::channel::<()>();
                let opened_tx = RefCell::new(Some(opened_tx));
                let w = weak.clone();
                conn.connect_message(move |_, kind, bytes| {
                    let Some(s) = w.upgrade() else { return };
                    if let Some(tx) = opened_tx.take() {
                        let _ = tx.send(());
                        let reconnected = s.ever_opened.replace(true);
                        if let Some(f) = s.on_open.borrow().as_ref() {
                            f(reconnected);
                        }
                    }
                    let frame = if kind == soup::WebsocketDataType::Text.into_glib() {
                        Frame::Text(String::from_utf8_lossy(bytes).into_owned())
                    } else {
                        Frame::Binary(glib::Bytes::clone(bytes))
                    };
                    if let Some(f) = s.on_frame.borrow().as_ref() {
                        f(frame);
                    }
                });
                let (closed_tx, closed_rx) = oneshot::channel::<()>();
                let closed_tx = RefCell::new(Some(closed_tx));
                conn.connect_closed(move |_| {
                    if let Some(tx) = closed_tx.take() {
                        let _ = tx.send(());
                    }
                });
                s.conn.replace(Some(conn));
                drop(s);
                let _ = closed_rx.await;
                open = opened_rx.now_or_never_opened();
                let Some(s) = weak.upgrade() else { return };
                s.conn.replace(None);
                if open {
                    retry = 0;
                    if let Some(f) = s.on_close.borrow().as_ref() {
                        f(());
                    }
                }
            }
            Err(_) => {
                let status = msg.status().into_glib() as u32;
                if status == 401 {
                    let Some(s) = weak.upgrade() else { return };
                    s.run.replace(None);
                    s.api.unauthorized();
                    return;
                }
            }
        }
        let delay = if open {
            1
        } else {
            max_delay.min(1 << retry.min(5))
        };
        retry += 1;
        glib::timeout_future_seconds(delay).await;
    }
}

trait Opened {
    fn now_or_never_opened(self) -> bool;
}

impl Opened for oneshot::Receiver<()> {
    /// Whether the first message came before the socket closed.
    fn now_or_never_opened(mut self) -> bool {
        matches!(self.try_recv(), Ok(Some(())))
    }
}

use glib::translate::IntoGlib;
