// L6: boxes (PLAN.md §24.2).
mod common;

use common::*;
use hatbot::net::api::Api;
use hatbot::store::Store;
use serde_json::json;

#[test]
fn a_box_missing_from_the_list_was_deleted_and_restoring_makes_a_new_version() {
    run(async {
        let brain = Brain::start();
        let app = |id: i64, version: i64| {
            json!({"id": id, "botId": "code", "conversationId": 1, "title": "Tip calculator",
                "version": version, "createdAt": "2026-10-15T10:00:00.000Z", "updatedAt": "2026-10-15T10:00:00.000Z"})
        };
        brain.answer("GET", "/boxes", json!([app(5, 1), app(6, 2)]));
        let store = Store::new(Api::new(brain.url(), Some(TOKEN.into())));
        store.load_boxes().await.unwrap();
        brain.answer("GET", "/boxes", json!([app(6, 2)]));
        store.load_boxes().await.unwrap();
        assert!(store.state().deleted_boxes.contains(&5));

        let mut detail = app(6, 3);
        detail["versions"] = json!([1, 2, 3].map(|n| json!({"n": n, "title": "Tip calculator",
            "createdAt": "2026-10-15T10:00:00.000Z", "messageId": null})));
        detail["secrets"] = json!([]);
        brain.answer("POST", "/boxes/6/revert", detail);
        let d = store.restore_box(6, 1).await.unwrap();
        assert_eq!(
            brain.got("POST", "/boxes/6/revert")[0].body,
            json!({"version": 1})
        );
        assert_eq!(d.versions.len(), 3);
        assert_eq!(store.state().boxes[&6].version, 3);
    });
}
