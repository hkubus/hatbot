// A WebSocket to the brain that comes back after it drops: the event stream and the live view.
use std::time::Duration;

use futures::channel::mpsc;
use futures::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{self, Message};

use super::api::Api;

#[derive(Debug, Clone, PartialEq)]
pub enum SocketEvent {
    /// The first message came: the socket counts as open. `reconnected` after it had been before.
    Open {
        reconnected: bool,
    },
    Text(String),
    Binary(Vec<u8>),
    Closed,
    /// The brain turned the token away at the handshake; the socket stops.
    Unauthorized,
}

/// Proxies drop idle sockets, and a dead one only shows when a ping goes unanswered.
const PING_EVERY: Duration = Duration::from_secs(25);
const PONG_WAIT: Duration = Duration::from_secs(10);

/// Runs until `events` is dropped or the token is turned away. What's sent on `outgoing` goes out as
/// text while the socket is open.
pub async fn run(
    api: Api,
    path: String,
    mut events: mpsc::Sender<SocketEvent>,
    mut outgoing: mpsc::Receiver<String>,
    max_delay: Duration,
) {
    let mut retry = 0u32;
    let mut ever_opened = false;
    loop {
        let mut req = match api.socket_url(&path).into_client_request() {
            Ok(r) => r,
            Err(_) => return,
        };
        if let Some(token) = &api.token
            && let Ok(v) = format!("Bearer {token}").parse()
        {
            req.headers_mut().insert("authorization", v);
        }
        match tokio_tungstenite::connect_async(req).await {
            Err(tungstenite::Error::Http(res)) if res.status() == 401 => {
                let _ = events.send(SocketEvent::Unauthorized).await;
                return;
            }
            Err(_) => {}
            Ok((ws, _)) => {
                let (mut tx, mut rx) = ws.split();
                let mut open = false;
                let mut ping = tokio::time::interval(PING_EVERY);
                ping.tick().await;
                let mut pong_due: Option<tokio::time::Instant> = None;
                loop {
                    let deadline = pong_due.unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(3600));
                    tokio::select! {
                        m = rx.next() => {
                            let Some(Ok(m)) = m else { break };
                            if !open && matches!(m, Message::Text(_) | Message::Binary(_)) {
                                open = true;
                                retry = 0;
                                let reconnected = ever_opened;
                                ever_opened = true;
                                if events.send(SocketEvent::Open { reconnected }).await.is_err() {
                                    return;
                                }
                            }
                            let sent = match m {
                                Message::Text(t) => events.send(SocketEvent::Text(t.to_string())).await,
                                Message::Binary(b) => events.send(SocketEvent::Binary(b.to_vec())).await,
                                Message::Pong(_) => { pong_due = None; Ok(()) }
                                Message::Close(_) => break,
                                _ => Ok(()),
                            };
                            if sent.is_err() {
                                return;
                            }
                        }
                        out = outgoing.next() => {
                            match out {
                                Some(text) => { let _ = tx.send(Message::text(text)).await; }
                                None => return,
                            }
                        }
                        _ = ping.tick() => {
                            if tx.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                            pong_due.get_or_insert(tokio::time::Instant::now() + PONG_WAIT);
                        }
                        _ = tokio::time::sleep_until(deadline), if pong_due.is_some() => break,
                    }
                }
                let _ = tx.close().await;
                if open && events.send(SocketEvent::Closed).await.is_err() {
                    return;
                }
            }
        }
        let delay = max_delay.min(Duration::from_secs(1u64 << retry.min(6)));
        retry += 1;
        tokio::time::sleep(delay).await;
        if events.is_closed() {
            return;
        }
    }
}
