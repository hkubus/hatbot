//! The socket to the brain: dialled out, so the computer needs no open port. It says hello, answers
//! requests, pushes status changes and, while Live is on, frames. It dials again, backing off, when
//! the socket drops.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message as Frame;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use crate::core::Core;
use crate::protocol::{self, ErrorCode, Hello, Message, Response};
use crate::{AgentConfig, Connection};

const PING_EVERY: Duration = Duration::from_secs(20);
/// Nothing from the brain for this long and the socket is taken for dead.
const SILENT_FOR: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// Where the agent dials: the brain's address, as http(s) or ws(s).
pub fn connect_url(brain: &str) -> String {
    let b = brain.trim().trim_end_matches('/');
    let b = if let Some(rest) = b.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = b.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        b.to_owned()
    };
    format!("{b}/api/v1/computer/connect")
}

/// 1, 2, 4… seconds up to 30, give or take a fifth so many computers don't all come back at once.
fn backoff(attempt: u32) -> Duration {
    let base = Duration::from_secs(1u64 << attempt.min(5)).min(MAX_BACKOFF);
    base.mul_f64(0.8 + rand::random::<f64>() * 0.4)
}

pub async fn run(
    config: AgentConfig,
    core: Arc<Core>,
    hello: impl Fn(bool) -> Hello,
    conn: watch::Sender<Connection>,
    mut stop: watch::Receiver<bool>,
) {
    let mut attempt = 0;
    loop {
        conn.send_replace(Connection::Connecting);
        let ended = tokio::select! {
            r = session(&config, &core, &hello, &conn, &mut attempt) => r,
            _ = stop.wait_for(|s| *s) => return,
        };
        // Whatever a task had going ends with the socket: the brain claims the screen again.
        core.disconnected();
        let wait = backoff(attempt);
        attempt += 1;
        conn.send_replace(Connection::Offline { error: ended, retry_in: wait });
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = stop.wait_for(|s| *s) => return,
        }
    }
}

/// One socket, until it ends; what ended it.
async fn session(
    config: &AgentConfig,
    core: &Arc<Core>,
    hello: &impl Fn(bool) -> Hello,
    conn: &watch::Sender<Connection>,
    attempt: &mut u32,
) -> String {
    let mut request = match connect_url(&config.brain_url).into_client_request() {
        Ok(r) => r,
        Err(_) => return "The brain's address isn't a valid URL.".into(),
    };
    let Ok(auth) = HeaderValue::from_str(&format!("Bearer {}", config.device_token)) else {
        return "The device token can't be sent.".into();
    };
    request.headers_mut().insert("authorization", auth);
    let socket = match tokio_tungstenite::connect_async(request).await {
        Ok((s, _)) => s,
        Err(tokio_tungstenite::tungstenite::Error::Http(res)) if res.status() == 401 => {
            return "The brain didn't accept this computer's token. Sign in again.".into();
        }
        Err(e) => return format!("Can't reach the brain: {e}."),
    };
    *attempt = 0;
    conn.send_replace(Connection::Connected);
    let (mut sink, mut stream) = socket.split();

    // Live frames are dropped, not queued, when the brain is slow to take them.
    let (out, mut outgoing) = mpsc::channel::<Frame>(16);
    let writer = tokio::spawn(async move {
        while let Some(f) = outgoing.recv().await {
            if sink.send(f).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let send = |m: &Message| Frame::text(serde_json::to_string(m).expect("serializable"));

    let mut status = core.subscribe();
    let mut live = core.live.subscribe();
    let first = hello(status.borrow_and_update().enabled);
    let _ = out.send(send(&Message::Hello(first))).await;

    let mut live_task: Option<JoinHandle<()>> = None;
    let mut ping = tokio::time::interval(PING_EVERY);
    let mut heard = Instant::now();
    let ended = loop {
        tokio::select! {
            m = stream.next() => {
                heard = Instant::now();
                let text = match m {
                    Some(Ok(Frame::Text(t))) => t,
                    Some(Ok(Frame::Close(_))) | None => break "The brain closed the connection.".to_string(),
                    Some(Err(e)) => break format!("The connection to the brain broke: {e}."),
                    Some(Ok(_)) => continue,
                };
                match protocol::read(&text) {
                    Ok(Message::Req { id, req }) => {
                        let core = core.clone();
                        let out = out.clone();
                        tokio::spawn(async move {
                            let res = match core.handle(req).await {
                                Ok(r) => Response::ok(id, r),
                                Err(r) => Response::err(id, r.code, r.error),
                            };
                            let _ = out.send(send(&Message::Res(res))).await;
                        });
                    }
                    Ok(_) => {}
                    Err(Some(id)) => {
                        let res = Response::err(id, ErrorCode::Failed, "Can't read that request.");
                        let _ = out.send(send(&Message::Res(res))).await;
                    }
                    Err(None) => tracing::warn!("unreadable message from the brain"),
                }
            }
            Ok(()) = status.changed() => {
                let s = status.borrow_and_update().clone();
                let _ = out.send(send(&Message::Status { status: s })).await;
            }
            Ok(()) = live.changed() => {
                let on = *live.borrow_and_update();
                if let Some(t) = live_task.take() {
                    t.abort();
                }
                if on {
                    live_task = Some(tokio::spawn(stream_live(core.clone(), out.clone())));
                }
            }
            _ = ping.tick() => {
                if heard.elapsed() > SILENT_FOR {
                    break "The brain stopped answering.".to_string();
                }
                let _ = out.try_send(Frame::Ping(Default::default()));
            }
        }
    };
    if let Some(t) = live_task {
        t.abort();
    }
    drop(out);
    writer.abort();
    ended
}

/// Frames while Live is on: at the watching or control rate, none while the screen doesn't change.
async fn stream_live(core: Arc<Core>, out: mpsc::Sender<Frame>) {
    let mut last = None;
    loop {
        let started = tokio::time::Instant::now();
        if let Ok(jpeg) = core.live_frame().await {
            let hash = {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                jpeg.hash(&mut h);
                h.finish()
            };
            if last != Some(hash) {
                last = Some(hash);
                let _ = out.try_send(Frame::binary(jpeg));
            }
        }
        let fps = core.live_fps().max(1);
        tokio::time::sleep_until(started + Duration::from_millis(1000 / fps as u64)).await;
    }
}
