// L2: the chat (PLAN.md §23.2).
mod common;

use common::*;
use hatbot::core::models::MessageStatus;
use hatbot::net::api::Api;
use hatbot::store::Store;
use serde_json::{Value, json};

#[test]
fn a_reply_streams_in_under_the_message_you_sent() {
    run(async {
        let brain = Brain::start();
        brain.route("POST", "/conversations/1/messages", |r| {
            (
                200,
                message(10, "user", r.body["text"].as_str().unwrap(), "done"),
            )
        });
        let store = Store::new(Api::new(brain.url(), Some(TOKEN.into())));
        store.connect();
        store.load_bots().await;
        store.open_conversation(1).await;
        wait_for("the stream", || brain.streams() == 1).await;

        store.send("Plan Saturday", &[], "c1").await.unwrap();
        assert_eq!(
            brain.got("POST", "/conversations/1/messages")[0].body["clientId"],
            "c1"
        );
        // The stream's news of your message as well as the POST's answer: it shows once.
        brain.send(json!({"type": "message.created", "message": message(10, "user", "Plan Saturday", "done")}));
        brain.send(json!({"type": "message.created", "message": message(11, "assistant", "", "streaming")}));
        brain.send(json!({"type": "message.delta", "id": 11, "text": "Shop", "at": 0}));
        brain.send(json!({"type": "message.delta", "id": 11, "text": "ping", "at": 4}));
        // Sent again after a reconnect: only what the reply doesn't have counts.
        brain.send(json!({"type": "message.delta", "id": 11, "text": "Shopping", "at": 0}));
        wait_for("the deltas", || {
            let st = store.state();
            st.messages
                .iter()
                .any(|m| m.id == 11 && st.text(m) == "Shopping")
        })
        .await;
        brain.send(
            json!({"type": "message.done", "id": 11, "text": "Shopping first.", "status": "done"}),
        );
        wait_for("the end of the reply", || {
            store
                .state()
                .messages
                .iter()
                .any(|m| m.id == 11 && m.status == MessageStatus::Done)
        })
        .await;
        let st = store.state();
        let ids: Vec<i64> = st.messages.iter().map(|m| m.id).collect();
        assert_eq!(ids, [10, 11]);
        assert_eq!(st.text(&st.messages[1]), "Shopping first.");
    });
}

#[test]
fn a_link_to_an_old_message_loads_earlier_pages_until_it_is_there() {
    run(async {
        let brain = Brain::start();
        // 150 messages, 50 to a page, newest first; nothing before 1.
        brain.route("GET", "/conversations/1/messages", |r| {
            let before: i64 = r.query.get("before").map_or(151, |b| b.parse().unwrap());
            let from = (before - 50).max(1);
            let page: Vec<Value> = (from..before)
                .map(|id| message(id, "user", "hi", "done"))
                .collect();
            (200, json!(page))
        });
        let store = Store::new(Api::new(brain.url(), Some(TOKEN.into())));
        store.load_bots().await;
        store.open_conversation(1).await;
        assert_eq!(store.state().messages[0].id, 101);

        assert!(store.reveal(30).await);
        assert_eq!(store.state().messages[0].id, 1);
        assert_eq!(brain.got("GET", "/conversations/1/messages").len(), 3);

        // Deleted since it was linked: the pages run out and it isn't there.
        assert!(!store.reveal(0).await);
        assert!(!store.state().has_earlier);
    });
}
