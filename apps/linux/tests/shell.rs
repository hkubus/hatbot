mod common;

use std::cell::Cell;
use std::rc::Rc;

use common::*;
use hatbot::core::models::ApprovalStatus;
use hatbot::net::api::Api;
use hatbot::session;
use hatbot::store::Store;
use serde_json::json;

#[test]
fn signing_in_gets_a_token_named_after_this_computer() {
    run(async {
        let brain = Brain::start();
        brain.answer(
            "GET",
            "/auth/me",
            json!({"setupDone": true, "authenticated": false}),
        );
        brain.answer("POST", "/auth/login", json!({"ok": true, "token": TOKEN}));
        let token = session::login(
            &Api::new(brain.url(), None),
            "secret",
            " 123456 ",
            "laptop (Hatbot Linux)",
        )
        .await;
        assert_eq!(token.unwrap(), TOKEN);
        let body = &brain.got("POST", "/auth/login")[0].body;
        assert_eq!(body["client"], "app");
        assert_eq!(body["device"], "laptop (Hatbot Linux)");
        assert_eq!(body["totp"], "123456");
    });
}

#[test]
fn signing_in_is_refused_before_setup_is_finished() {
    run(async {
        let brain = Brain::start();
        brain.answer(
            "GET",
            "/auth/me",
            json!({"setupDone": false, "authenticated": false}),
        );
        let err = session::login(&Api::new(brain.url(), None), "secret", "123456", "laptop")
            .await
            .unwrap_err();
        assert_eq!(
            err.message,
            "Finish setting up Hatbot in the web app first."
        );
        assert!(brain.got("POST", "/auth/login").is_empty());
    });
}

#[test]
fn the_stream_reloads_what_changed_while_it_was_down() {
    run(async {
        let brain = Brain::start();
        brain.answer("GET", "/approvals", json!([approval(1, "pending")]));
        let store = Store::new(Api::new(brain.url(), Some(TOKEN.into())));
        store.connect();
        wait_for("the first approval", || {
            store.state().approvals.contains_key(&1)
        })
        .await;
        assert_eq!(
            brain.got("GET", "/bots")[0].auth.as_deref(),
            Some("Bearer hbt_test")
        );

        // While it's down, the first is approved elsewhere, another comes, and a message is sent.
        brain.answer("GET", "/approvals", json!([approval(2, "pending")]));
        brain.answer(
            "GET",
            "/conversations/1/messages",
            json!([message(5, "assistant", "Done.", "done")]),
        );
        brain.drop_streams();
        wait_for("the reconnect's reload", || {
            let st = store.state();
            st.approvals.contains_key(&2) && st.messages.iter().any(|m| m.id == 5)
        })
        .await;
        let st = store.state();
        assert!(!st.approvals.contains_key(&1));
        assert_eq!(st.pending_approvals().len(), 1);
        assert_eq!(st.approvals[&2].status, ApprovalStatus::Pending);
        assert!(st.connected);
    });
}

#[test]
fn a_401_signs_you_out_but_a_wrong_password_does_not() {
    run(async {
        let brain = Brain::start();
        brain.route("GET", "/bots", |_| {
            (401, json!({"error": "You're not signed in."}))
        });
        brain.route("POST", "/auth/login", |_| {
            (401, json!({"error": "That password or code isn't right."}))
        });
        brain.answer(
            "GET",
            "/auth/me",
            json!({"setupDone": true, "authenticated": false}),
        );
        let api = Api::new(brain.url(), Some(TOKEN.into()));
        let signed_out = Rc::new(Cell::new(false));
        let flag = signed_out.clone();
        api.on_unauthorized(move || flag.set(true));

        let err = session::login(&api, "wrong", "123456", "laptop")
            .await
            .unwrap_err();
        assert_eq!(err.message, "That password or code isn't right.");
        assert!(!signed_out.get());

        Store::new(api).load_bots().await;
        assert!(signed_out.get());
    });
}
