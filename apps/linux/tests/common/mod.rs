// A fake brain on libsoup's server, on 127.0.0.1, for end-to-end tests of the store, the API client
// and the stream. Plain http: the https rule is for addresses typed at sign-in.
#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gtk::glib;
use serde_json::{Value, json};
use soup::prelude::*;

pub const TOKEN: &str = "hbt_test";

/// A request the brain got.
#[derive(Debug, Clone)]
pub struct Req {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, String>,
    pub body: Value,
    pub auth: Option<String>,
}

type Route = Box<dyn Fn(&Req) -> (u32, Value)>;

#[derive(Clone)]
pub struct Brain(Rc<Inner>);

pub struct Inner {
    server: soup::Server,
    pub url: String,
    routes: RefCell<HashMap<(String, String), Route>>,
    pub requests: RefCell<Vec<Req>>,
    streams: RefCell<Vec<soup::WebsocketConnection>>,
    /// The first event a new stream gets, as the brain's is `paused`.
    hello: RefCell<Value>,
}

impl Brain {
    /// A brain that answers what a freshly signed-in app loads, with nothing in it.
    pub fn start() -> Brain {
        let server = soup::Server::builder().build();
        server
            .listen_local(0, soup::ServerListenOptions::IPV4_ONLY)
            .expect("a free port");
        let port = server.uris()[0].port();
        let brain = Brain(Rc::new(Inner {
            server,
            url: format!("http://127.0.0.1:{port}"),
            routes: RefCell::default(),
            requests: RefCell::default(),
            streams: RefCell::default(),
            hello: RefCell::new(json!({"type": "paused", "paused": false})),
        }));
        let weak = Rc::downgrade(&brain.0);
        brain.0.server.add_websocket_handler(
            Some("/api/v1/stream"),
            None,
            &[],
            move |_, _, _, conn| {
                let Some(b) = weak.upgrade() else { return };
                conn.send_text(&b.hello.borrow().to_string());
                b.streams.borrow_mut().push(conn.clone());
            },
        );
        let weak = Rc::downgrade(&brain.0);
        brain
            .0
            .server
            .add_handler(None, move |_, msg, path, query| {
                let Some(b) = weak.upgrade() else { return };
                let body = msg
                    .request_body()
                    .and_then(|b| b.flatten())
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                    .unwrap_or(Value::Null);
                let req = Req {
                    method: msg.method().map(|m| m.to_string()).unwrap_or_default(),
                    path: path.to_string(),
                    query: query
                        .into_iter()
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                        .collect(),
                    body,
                    auth: msg
                        .request_headers()
                        .and_then(|h| h.one("Authorization"))
                        .map(|a| a.to_string()),
                };
                let key = (req.method.clone(), req.path.clone());
                let (status, out) = match b.routes.borrow().get(&key) {
                    Some(route) => route(&req),
                    None => (404, json!({"error": "That's gone."})),
                };
                b.requests.borrow_mut().push(req);
                msg.set_status(status, None);
                msg.set_response(
                    Some("application/json"),
                    soup::MemoryUse::Copy,
                    out.to_string().as_bytes(),
                );
            });
        for (path, out) in [
            (
                "/bots",
                json!([{"id": "hatbot", "name": "Hatbot", "icon": "hat", "color": "amber", "instructions": ""}]),
            ),
            (
                "/conversations",
                json!([{"id": 1, "kind": "direct", "title": null, "botIds": ["hatbot"], "unread": 0, "lastMessageAt": null}]),
            ),
            ("/approvals", json!([])),
            ("/questions", json!([])),
            (
                "/desktop/status",
                json!({"online": true, "control": "hatbot", "request": null, "activeTaskId": null, "botId": null}),
            ),
            ("/thread/unread", json!([])),
            ("/spend/summary", json!({"todayUsd": 0.5, "monthUsd": 12.0})),
            ("/conversations/1/messages", json!([])),
        ] {
            brain.answer("GET", path, out);
        }
        brain
    }

    pub fn url(&self) -> &str {
        &self.0.url
    }

    /// Answers `method path` (under /api/v1) with `route`'s status and JSON.
    pub fn route(&self, method: &str, path: &str, route: impl Fn(&Req) -> (u32, Value) + 'static) {
        self.0
            .routes
            .borrow_mut()
            .insert((method.into(), format!("/api/v1{path}")), Box::new(route));
    }

    /// Answers `method path` with 200 and `out`.
    pub fn answer(&self, method: &str, path: &str, out: Value) {
        self.route(method, path, move |_| (200, out.clone()));
    }

    /// The requests to `path` (under /api/v1) so far.
    pub fn got(&self, method: &str, path: &str) -> Vec<Req> {
        let path = format!("/api/v1{path}");
        self.0
            .requests
            .borrow()
            .iter()
            .filter(|r| r.method == method && r.path == path)
            .cloned()
            .collect()
    }

    /// An event to every open stream.
    pub fn send(&self, event: Value) {
        for conn in self.0.streams.borrow().iter() {
            if conn.state() == soup::WebsocketState::Open {
                conn.send_text(&event.to_string());
            }
        }
    }

    pub fn streams(&self) -> usize {
        self.0
            .streams
            .borrow()
            .iter()
            .filter(|c| c.state() == soup::WebsocketState::Open)
            .count()
    }

    /// Closes every stream, as a restart or a dropped connection does.
    pub fn drop_streams(&self) {
        for conn in self.0.streams.borrow_mut().drain(..) {
            conn.close(1001, None);
        }
    }
}

/// Runs `f` on a main context of its own, as the app runs on GTK's.
pub fn run<F: Future<Output = ()>>(f: F) {
    let ctx = glib::MainContext::new();
    ctx.with_thread_default(|| ctx.block_on(f))
        .expect("a main context");
}

/// Waits until `cond` holds, letting the main loop run; fails after five seconds.
pub async fn wait_for(what: &str, cond: impl Fn() -> bool) {
    let start = Instant::now();
    while !cond() {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "timed out waiting for {what}"
        );
        glib::timeout_future(Duration::from_millis(5)).await;
    }
}

pub fn message(id: i64, role: &str, text: &str, status: &str) -> Value {
    json!({
        "id": id, "role": role, "conversationId": 1, "botId": if role == "user" { Value::Null } else { json!("hatbot") },
        "kind": "text", "text": text, "status": status, "createdAt": "2026-10-20T10:00:00.000Z",
        "taskId": null, "scheduleId": null, "negotiationId": null, "boxId": null,
        "episodeId": 1, "editedAt": null, "seenAt": null
    })
}

pub fn approval(id: i64, status: &str) -> Value {
    json!({
        "id": id, "botId": "hatbot", "taskId": 7, "conversationId": null, "kind": "purchase",
        "summary": "Buy the cat food", "reason": "It's on your list", "sources": [], "screenshotStepId": null,
        "status": status, "decidedVia": null, "costUsd": 0.1, "createdAt": "2026-10-20T10:00:00.000Z",
        "expiresAt": "2026-10-21T10:00:00.000Z", "decidedAt": null, "note": null
    })
}
