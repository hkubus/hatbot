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

#[test]
fn a_box_opens_at_its_signed_address_and_its_calls_pass_through_as_they_came() {
    run(async {
        let brain = Brain::start();
        brain.answer(
            "POST",
            "/boxes/6/open",
            json!({"url": "/api/v1/boxes/6/frame?v=2&sig=abc"}),
        );
        let store = Store::new(Api::new(brain.url(), Some(TOKEN.into())));
        let url = store.open_box(6, 2, true).await.unwrap();
        assert_eq!(
            url,
            format!("{}/api/v1/boxes/6/frame?v=2&sig=abc", brain.url())
        );
        assert_eq!(
            brain.got("POST", "/boxes/6/open")[0].body,
            json!({"version": 2, "dark": true})
        );

        brain.answer(
            "POST",
            "/boxes/6/call",
            json!({"value": {"tips": [1.5, 2]}}),
        );
        let call = json!({"op": "set", "key": "tips", "value": {"tips": [1.5, 2], "at": null}});
        let value = store.call_box(6, &call).await.unwrap();
        assert_eq!(brain.got("POST", "/boxes/6/call")[0].body, call);
        assert_eq!(value, Some(json!({"tips": [1.5, 2]})));
        brain.answer("POST", "/boxes/6/call", json!({}));
        assert_eq!(store.call_box(6, &call).await.unwrap(), None);
    });
}

#[test]
fn a_box_page_loads_once_moves_only_within_itself_and_sends_web_links_out() {
    use hatbot::core::boxes::{Navigation, decide};
    let page = "https://hat.example/api/v1/boxes/6/frame?v=2&sig=abc";
    assert_eq!(decide(page, false, false, page, false), Navigation::Allow);
    assert_eq!(decide(page, false, false, page, true), Navigation::Leave);
    assert_eq!(
        decide(&format!("{page}#notes"), false, true, page, true),
        Navigation::Allow
    );
    assert_eq!(
        decide(
            "https://hat.example/api/v1/boxes/6/frame?v=2&sig=other",
            false,
            false,
            page,
            false
        ),
        Navigation::Leave
    );
    assert_eq!(
        decide("about:srcdoc", false, false, page, true),
        Navigation::Allow
    );
    let web = "https://en.wikipedia.org/wiki/Tipping";
    assert_eq!(
        decide(web, false, true, page, true),
        Navigation::Open(web.into())
    );
    assert_eq!(decide(web, false, false, page, true), Navigation::Leave);
    assert_eq!(
        decide(web, true, false, page, true),
        Navigation::Open(web.into())
    );
    assert_eq!(
        decide("data:text/html,hi", true, true, page, true),
        Navigation::Refuse
    );
    assert_eq!(decide(page, true, true, page, true), Navigation::Refuse);
}
