mod common;

use common::fake_brain;
use hatbot::core::api::Api;
use hatbot::core::models::Approval;
use hatbot::core::session::sign_in;

#[tokio::test]
async fn signing_in_asks_for_an_app_token_named_after_the_device() {
    let brain = fake_brain(&[
        ("GET /auth/me", 200, r#"{"setupDone":true,"authenticated":false}"#),
        ("POST /auth/login", 200, r#"{"ok":true,"token":"hb_123"}"#),
    ])
    .await;
    let (server, token) = sign_in(&brain.url, "correct horse", "123 456", "box (Linux)").await.unwrap();
    assert_eq!((server.as_str(), token.as_str()), (brain.url.as_str(), "hb_123"));
    let seen = brain.seen.lock().unwrap();
    let body: serde_json::Value = serde_json::from_str(&seen[1].body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"password":"correct horse","totp":"123456","client":"app","device":"box (Linux)"})
    );
}

#[tokio::test]
async fn a_brain_not_set_up_is_refused_before_the_password_goes() {
    let brain = fake_brain(&[("GET /auth/me", 200, r#"{"setupDone":false,"authenticated":false}"#)]).await;
    assert!(sign_in(&brain.url, "pw", "123456", "d").await.is_err());
    assert_eq!(brain.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_wrong_code_says_what_the_brain_said() {
    let brain = fake_brain(&[
        ("GET /auth/me", 200, r#"{"setupDone":true,"authenticated":false}"#),
        ("POST /auth/login", 401, r#"{"error":"That code didn't work."}"#),
    ])
    .await;
    let err = sign_in(&brain.url, "pw", "000000", "d").await.unwrap_err();
    assert_eq!((err.status, err.message.as_str()), (401, "That code didn't work."));
}

#[tokio::test]
async fn requests_carry_the_token_and_decode_the_answer() {
    let brain = fake_brain(&[(
        "POST /approvals/7",
        200,
        r#"{"id":7,"botId":"hatbot","taskId":3,"conversationId":null,"episodeId":null,"kind":"send","summary":"Send it","reason":"","sources":[],"screenshotStepId":null,"status":"approved","decidedVia":"web","costUsd":0,"createdAt":"2026-10-29T10:00:00.000Z","expiresAt":"2026-10-30T10:00:00.000Z","decidedAt":null,"note":null,"scopes":[],"scope":null}"#,
    )])
    .await;
    let api = Api::new(&brain.url, Some("hb_123".into()));
    let a: Approval = api.post("/approvals/7", &serde_json::json!({"decision":"approve"})).await.unwrap();
    assert_eq!(a.id, 7);
    assert_eq!(brain.seen.lock().unwrap()[0].authorization.as_deref(), Some("Bearer hb_123"));
}

#[tokio::test]
async fn a_revoked_token_shows_as_unauthorized() {
    let brain = fake_brain(&[("GET /todo", 401, r#"{"error":"You're not signed in."}"#)]).await;
    let api = Api::new(&brain.url, Some("old".into()));
    let err = api.get::<serde_json::Value>("/todo").await.unwrap_err();
    assert!(err.is_unauthorized());
}

#[tokio::test]
async fn an_unreachable_brain_is_said_plainly() {
    let api = Api::new("http://127.0.0.1:9", None);
    let err = api.get::<serde_json::Value>("/auth/me").await.unwrap_err();
    assert_eq!(err.status, 0);
}
