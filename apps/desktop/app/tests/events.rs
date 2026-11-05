use hatbot::core::models::*;
use hatbot::core::watch::Watch;

const SNAPSHOT: &str = r#"{"type":"snapshot","paused":false,
 "bots":[{"id":"hatbot","name":"Hatbot","icon":"hat","color":"amber","instructions":"","chatModel":null,"createdAt":"2026-10-01T00:00:00.000Z","brief":true}],
 "conversations":[{"id":1,"kind":"direct","title":null,"botIds":["hatbot"],"unread":1}],
 "approvals":[{"id":4,"botId":"hatbot","taskId":9,"conversationId":1,"kind":"payment","summary":"Pay 40 zł","reason":"","sources":[],"status":"pending","costUsd":0,"createdAt":"2026-10-29T10:00:00.000Z","scopes":[],"scope":null}],
 "questions":[],
 "desktop":{"online":true,"control":"hatbot","request":null,"activeTaskId":null,"botId":null},
 "unread":[12]}"#;

fn task(status: &str) -> String {
    format!(
        r#"{{"type":"task.updated","task":{{"id":2,"botId":"hatbot","title":"Book it","status":"{status}","createdAt":"2026-10-29T10:00:00.000Z"}}}}"#
    )
}

#[test]
fn the_snapshot_brings_what_waits_on_you() {
    let mut w = Watch::default();
    w.apply(Event::parse(SNAPSHOT));
    assert_eq!(w.bot_name("hatbot"), "Hatbot");
    let open = w.open();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].key(), "approval-4");
}

#[test]
fn events_a_newer_brain_adds_are_unknown() {
    for e in [
        r#"{"type":"negotiation.updated","negotiation":{"id":1}}"#,
        r#"{"type":"message.delta","id":3,"text":"Hi","at":0}"#,
        r#"not json"#,
    ] {
        assert_eq!(Event::parse(e), Event::Unknown, "{e}");
    }
}

#[test]
fn values_a_newer_brain_adds_fall_back() {
    let Event::TaskUpdated { task } = Event::parse(&task("sleeping")) else { panic!() };
    assert_eq!(task.status, TaskStatus::Running);
    let a: Approval = serde_json::from_str(r#"{"id":1,"kind":"teleport","summary":"x","status":"pondering"}"#).unwrap();
    assert_eq!((a.kind, a.status), (ApprovalKind::Unknown, ApprovalStatus::Cancelled));
}

#[test]
fn only_a_task_seen_running_that_ends_is_told() {
    let mut w = Watch::default();
    assert!(w.apply(Event::parse(&task("done"))).is_none());
    w.apply(Event::parse(&task("running")));
    assert!(w.apply(Event::parse(&task("cancelled"))).is_none());
    w.apply(Event::parse(&task("running")));
    assert_eq!(w.apply(Event::parse(&task("failed"))).map(|t| t.status), Some(TaskStatus::Failed));
    assert!(w.apply(Event::parse(&task("failed"))).is_none());
}

#[test]
fn a_task_running_when_the_stream_opened_is_told_when_it_ends() {
    let mut w = Watch::default();
    let Event::TaskUpdated { task: running } = Event::parse(&task("running")) else { panic!() };
    w.take_tasks(vec![running]);
    assert!(w.apply(Event::parse(&task("done"))).is_some());
}

#[test]
fn an_approval_answered_elsewhere_stops_waiting() {
    let mut w = Watch::default();
    w.apply(Event::parse(SNAPSHOT));
    w.apply(Event::parse(
        r#"{"type":"approval.resolved","approval":{"id":4,"kind":"payment","summary":"Pay 40 zł","status":"approved"}}"#,
    ));
    assert!(w.open().is_empty());
}

#[test]
fn blocked_and_sending_dont_wait_on_you_and_a_new_snapshot_drops_them() {
    let mut w = Watch::default();
    let snapshot = SNAPSHOT.replace(
        r#""approvals":[{"id":4"#,
        r#""approvals":[{"id":5,"kind":"send","summary":"Text Ola","status":"blocked"},{"id":6,"kind":"send","summary":"Text Ola","status":"sending"},{"id":4"#,
    );
    w.apply(Event::parse(&snapshot));
    assert_eq!(w.open().len(), 1);
    w.apply(Event::parse(&SNAPSHOT.replace(r#""status":"pending""#, r#""status":"approved""#)));
    assert!(w.open().is_empty());
}
