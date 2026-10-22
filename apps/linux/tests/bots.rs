mod common;

use common::*;
use hatbot::core::models::{BotChange, GroupChange};
use hatbot::net::api::Api;
use hatbot::store::Store;
use serde_json::json;

fn bot(id: &str, name: &str) -> serde_json::Value {
    json!({"id": id, "name": name, "icon": "hat", "color": "amber", "instructions": "",
        "chatModel": null, "chatEffort": null, "plugins": null, "createdAt": "2026-10-21T10:00:00Z"})
}

fn chat(id: i64, kind: &str, bots: &[&str]) -> serde_json::Value {
    json!({"id": id, "kind": kind, "title": null, "botIds": bots, "unread": 0, "lastMessageAt": null})
}

#[test]
fn a_new_bot_comes_with_its_chat_and_goes_with_it_and_hatbot_keeps_its_name() {
    run(async {
        let brain = Brain::start();
        brain.answer("GET", "/bots", json!([bot("hatbot", "Hatbot")]));
        brain.answer(
            "GET",
            "/conversations",
            json!([chat(1, "direct", &["hatbot"])]),
        );
        let store = Store::new(Api::new(brain.url(), Some(TOKEN.into())));
        store.load_bots().await;

        let change = BotChange {
            name: Some("Chef".into()),
            icon: "cart".into(),
            color: "green".into(),
            instructions: String::new(),
            chat_model: None,
            chat_effort: None,
            plugins: None,
        };
        brain.answer("POST", "/bots", bot("chef", "Chef"));
        brain.answer(
            "GET",
            "/bots",
            json!([bot("hatbot", "Hatbot"), bot("chef", "Chef")]),
        );
        brain.answer(
            "GET",
            "/conversations",
            json!([chat(1, "direct", &["hatbot"]), chat(2, "direct", &["chef"])]),
        );
        store.create_bot(&change).await.unwrap();
        // "As in Settings" and "every plugin that's on" go as null.
        let sent = &brain.got("POST", "/bots")[0].body;
        assert_eq!(
            (sent["chatModel"].is_null(), sent["plugins"].is_null()),
            (true, true)
        );
        assert_eq!(store.bot_chat("chef"), Some(2));

        brain.answer(
            "POST",
            "/conversations",
            chat(3, "group", &["hatbot", "chef"]),
        );
        let group = GroupChange {
            title: String::new(),
            bot_ids: vec!["hatbot".into(), "chef".into()],
        };
        store.create_group(&group).await.unwrap();
        assert_eq!(store.state().conversations.len(), 3);

        brain.answer("DELETE", "/bots/chef", json!({"ok": true}));
        brain.answer("GET", "/bots", json!([bot("hatbot", "Hatbot")]));
        brain.answer(
            "GET",
            "/conversations",
            json!([
                chat(1, "direct", &["hatbot"]),
                chat(3, "group", &["hatbot", "chef"])
            ]),
        );
        store.delete_bot("chef").await.unwrap();
        assert_eq!(store.bot_chat("chef"), None);

        brain.answer("PATCH", "/bots/hatbot", bot("hatbot", "Hatbot"));
        let keep = BotChange {
            name: None,
            ..change
        };
        store.update_bot("hatbot", &keep).await.unwrap();
        assert!(
            brain.got("PATCH", "/bots/hatbot")[0]
                .body
                .get("name")
                .is_none()
        );
    });
}
