// L6: search and the to-do list (PLAN.md §23.2).
mod common;

use common::*;
use hatbot::net::api::Api;
use hatbot::store::Store;
use serde_json::json;

#[test]
fn search_asks_for_what_was_typed_and_a_to_do_is_added_worked_on_and_ticked_off() {
    run(async {
        let brain = Brain::start();
        brain.answer(
            "GET",
            "/search",
            json!({"query": "fish & chips", "messages": [{"id": 4, "conversationId": 1, "botId": null,
                "snippet": "\u{2}fish\u{3} & chips", "createdAt": "2026-10-20T10:00:00.000Z"}],
                "tasks": [], "memory": [], "routines": [{"kind": "watcher", "id": 2, "name": "Chippy"}]}),
        );
        let item = |done: bool, task: Option<i64>| {
            json!({"line": 2, "done": done, "text": "Renew the domain", "due": "2026-10-25", "at": null,
                "doneOn": if done { json!("2026-10-21") } else { json!(null) }, "taskId": task})
        };
        brain.route("POST", "/todo", move |_| {
            (201, json!({"items": [item(false, None)]}))
        });
        brain.route("POST", "/todo/work", |_| {
            let mut t = task(30, "queued");
            t["todo"] = json!("Renew the domain");
            (201, t)
        });
        brain.answer("POST", "/todo/done", json!({"items": [item(true, None)]}));
        let store = Store::new(Api::new(brain.url(), Some(TOKEN.into())));

        let found = store.search("fish & chips").await.unwrap();
        assert_eq!(brain.got("GET", "/search")[0].query["q"], "fish & chips");
        assert_eq!(found.messages[0].bot_id, None);
        assert_eq!(found.routines[0].id, 2);

        let list = store
            .add_todo("Renew the domain", Some("2026-10-25"))
            .await
            .unwrap();
        assert_eq!(
            brain.got("POST", "/todo")[0].body,
            json!({"item": "Renew the domain", "due": "2026-10-25"})
        );
        let t = &list.items[0];
        let task = store.work_on_todo(t).await.unwrap();
        assert_eq!(
            brain.got("POST", "/todo/work")[0].body,
            json!({"text": "Renew the domain", "line": 2})
        );
        assert_eq!(
            store.state().tasks[&task.id].todo.as_deref(),
            Some("Renew the domain")
        );
        let list = store.tick_todo(t).await.unwrap();
        assert!(list.items[0].done);
    });
}
