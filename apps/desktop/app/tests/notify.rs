use hatbot::core::models::*;
use hatbot::core::notify::{Notice, Reply, Target};
use serde_json::json;

fn approval(kind: &str) -> Approval {
    serde_json::from_value(json!({"id": 8, "kind": kind, "summary": "Send the invoice to Ola", "status": "pending"}))
        .unwrap()
}

#[test]
fn approve_and_deny_answer_the_approval() {
    let n = Notice::Approval(approval("send"));
    assert_eq!(n.reply("approve"), Reply::Call { path: "/approvals/8".into(), body: json!({"decision": "approve"}) });
    assert_eq!(n.reply("deny"), Reply::Call { path: "/approvals/8".into(), body: json!({"decision": "deny"}) });
    assert_eq!(n.reply("default"), Reply::Open(Target("/?approval=8".into())));
    let labels: Vec<String> = n.shown("Hatbot").actions.into_iter().map(|a| a.0).collect();
    assert_eq!(labels, ["default", "approve", "deny"]);
}

#[test]
fn money_keys_doors_and_suspicions_open_the_window_instead() {
    for kind in
        ["purchase", "payment", "mandate", "account_security", "access", "computer", "budget", "injection_warning"]
    {
        let n = Notice::Approval(approval(kind));
        assert_eq!(n.shown("Hatbot").actions.len(), 1, "{kind}");
        assert_eq!(n.reply("approve"), Reply::Open(Target("/?approval=8".into())), "{kind}");
    }
}

#[test]
fn a_question_is_answered_with_the_choice_pressed() {
    let q: Question = serde_json::from_value(
        json!({"id": 3, "taskId": 9, "question": "Which flat?", "choices": ["The first", "The second"], "status": "pending"}),
    )
    .unwrap();
    let n = Notice::Question(q);
    assert_eq!(n.reply("answer:1"), Reply::Call { path: "/questions/3".into(), body: json!({"answer": "The second"}) });
    assert_eq!(n.reply("answer:7"), Reply::Open(Target("/tasks/9".into())));
}
