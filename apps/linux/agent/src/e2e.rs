//! The agent against a stand-in brain: it dials in with its token, says hello, and a task takes the
//! screen, looks, clicks and lets go.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as Frame;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

use crate::computer::Button;
use crate::fake::{Call, Fake};
use crate::protocol::{ComputerResult, Message};
use crate::{Agent, AgentConfig};

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn a_task_takes_the_screen_looks_clicks_and_lets_go() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let fake = Arc::new(Fake::new());
    let (events_tx, events) = mpsc::unbounded_channel();
    let agent = Agent::start_with(
        AgentConfig {
            brain_url: format!("http://127.0.0.1:{port}"),
            device_token: "tok".into(),
            enabled: true,
        },
        fake.clone(),
        events,
    );

    let (tcp, _) = listener.accept().await.unwrap();
    let mut ws = tokio_tungstenite::accept_hdr_async(tcp, |req: &Request, res: Response| {
        assert_eq!(req.uri().path(), "/api/v1/computer/connect");
        let auth = req.headers().get("authorization").map(|h| h.to_str().unwrap().to_owned());
        if auth.as_deref() == Some("Bearer tok") { Ok(res) } else { Err(ErrorResponse::new(None)) }
    })
    .await
    .unwrap();

    let mut next = async || -> Message {
        loop {
            match ws.next().await.unwrap().unwrap() {
                Frame::Text(t) => return serde_json::from_str(&t).unwrap(),
                _ => continue,
            }
        }
    };
    let Message::Hello(hello) = next().await else { panic!("no hello") };
    assert!(hello.enabled);
    assert_eq!(hello.compositor, "niri");
    assert_eq!(hello.machine_id.len(), 32);

    let mut id = 0;
    let mut statuses = Vec::new();
    let mut ask = async |req: Value| -> Value {
        id += 1;
        ws.send(Frame::text(json!({"t": "req", "id": id, "req": req}).to_string())).await.unwrap();
        loop {
            let Frame::Text(t) = ws.next().await.unwrap().unwrap() else { continue };
            let v: Value = serde_json::from_str(&t).unwrap();
            if v["t"] == "status" {
                statuses.push(v["status"].clone());
            } else if v["t"] == "res" && v["id"] == id {
                return v;
            }
        }
    };

    let claim = ask(json!({"op": "claim", "taskId": "t1"})).await;
    assert_eq!(
        claim["res"]["screen"],
        json!({"output": "DP-1", "width": 1600, "height": 1000, "scale": 1.0})
    );
    let shot = ask(json!({"op": "screenshot"})).await;
    let res: ComputerResult = serde_json::from_value(shot["res"].clone()).unwrap();
    let ComputerResult::Screenshot { data, width, height } = res else { panic!("no screenshot") };
    assert_eq!((width, height), (1280, 800));
    assert!(!data.is_empty());
    let clicked =
        ask(json!({"op": "action", "name": "left_click", "input": {"coordinate": [640, 400]}}))
            .await;
    assert_eq!(clicked["ok"], true);
    assert!(
        fake.calls()
            .ends_with(&[Call::Button(Button::Left, true), Call::Button(Button::Left, false)])
    );
    let unknown = ask(json!({"op": "teleport"})).await;
    assert_eq!((unknown["ok"].clone(), unknown["code"].clone()), (json!(false), json!("failed")));
    assert_eq!(ask(json!({"op": "release", "taskId": "t1"})).await["ok"], true);

    // The owner switching it off reaches the brain unasked, and refusals follow.
    agent.set_enabled(false);
    let off = ask(json!({"op": "screenshot"})).await;
    assert_eq!(off["code"], "disabled");
    // The status may come after the answer: it's pushed from elsewhere.
    while statuses.last().map(|s| s["enabled"].clone()) != Some(json!(false)) {
        let Frame::Text(t) = ws.next().await.unwrap().unwrap() else { continue };
        let v: Value = serde_json::from_str(&t).unwrap();
        if v["t"] == "status" {
            statuses.push(v["status"].clone());
        }
    }
    drop(events_tx);
    tokio::task::spawn_blocking(move || agent.shutdown()).await.unwrap();
}
