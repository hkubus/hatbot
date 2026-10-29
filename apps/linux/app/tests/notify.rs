use hatbot::core::models::*;
use hatbot::core::notify::{Notice, Reply, Target, task_ended};
use serde_json::json;

fn approval(kind: &str) -> Approval {
    serde_json::from_value(json!({"id": 8, "kind": kind, "summary": "Send the invoice to Ola", "status": "pending"})).unwrap()
}

#[test]
fn approve_and_deny_answer_the_approval() {
    let n = Notice::Approval(approval("send"));
    assert_eq!(
        n.reply("approve"),
        Reply::Call { path: "/approvals/8".into(), body: json!({"decision": "approve"}) }
    );
    assert_eq!(n.reply("deny"), Reply::Call { path: "/approvals/8".into(), body: json!({"decision": "deny"}) });
    assert_eq!(n.reply("default"), Reply::Open(Target::Approval(8)));
    let labels: Vec<String> = n.shown("Hatbot").actions.into_iter().map(|a| a.0).collect();
    assert_eq!(labels, ["default", "approve", "deny"]);
}

#[test]
fn money_passwords_and_keys_open_the_window_instead() {
    for kind in ["purchase", "payment", "mandate", "account_security"] {
        let n = Notice::Approval(approval(kind));
        assert_eq!(n.shown("Hatbot").actions.len(), 1, "{kind}");
        assert_eq!(n.reply("approve"), Reply::Open(Target::Approval(8)), "{kind}");
    }
}

#[test]
fn a_question_is_answered_with_the_choice_pressed() {
    let q: Question = serde_json::from_value(
        json!({"id": 3, "taskId": 9, "question": "Which flat?", "choices": ["The first", "The second"], "status": "pending"}),
    )
    .unwrap();
    let n = Notice::Question(q);
    assert_eq!(
        n.reply("answer:1"),
        Reply::Call { path: "/questions/3".into(), body: json!({"answer": "The second"}) }
    );
    assert_eq!(n.reply("answer:7"), Reply::Open(Target::Question(3)));
}

#[test]
fn only_a_task_that_just_ended_is_told() {
    let t = |status: &str| -> Task {
        serde_json::from_value(json!({"id": 2, "title": "Book it", "status": status, "createdAt": "2026-10-29T10:00:00.000Z"})).unwrap()
    };
    assert!(task_ended(Some(&t("running")), &t("done")));
    assert!(task_ended(Some(&t("running")), &t("failed")));
    assert!(!task_ended(Some(&t("done")), &t("done")));
    assert!(!task_ended(None, &t("done")));
    assert!(!task_ended(Some(&t("running")), &t("cancelled")));
}
