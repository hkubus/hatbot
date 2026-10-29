use hatbot::core::models::*;
use hatbot::core::store::{Effect, Store};

const SNAPSHOT: &str = r#"{"type":"snapshot","paused":false,
 "bots":[{"id":"hatbot","name":"Hatbot","icon":"hat","color":"amber","instructions":"","chatModel":null,"chatEffort":null,"plugins":null,"createdAt":"2026-10-01T00:00:00.000Z","brief":true}],
 "conversations":[{"id":1,"kind":"direct","title":null,"botIds":["hatbot"],"unread":1,"lastMessageAt":"2026-10-29T10:00:00.000Z","parentId":null,"resolvedAt":null,"outcome":null,"latest":null,"needsYou":false}],
 "approvals":[{"id":4,"botId":"hatbot","taskId":9,"conversationId":1,"episodeId":null,"kind":"payment","summary":"Pay 40 zł","reason":"","sources":[],"screenshotStepId":null,"status":"pending","decidedVia":null,"costUsd":0,"createdAt":"2026-10-29T10:00:00.000Z","expiresAt":"2026-10-30T10:00:00.000Z","decidedAt":null,"note":null,"scopes":[],"scope":null}],
 "questions":[],
 "desktop":{"online":true,"control":"hatbot","request":null,"activeTaskId":null,"botId":null},
 "unread":[12]}"#;

fn message(id: i64, status: &str, text: &str) -> String {
    format!(
        r#"{{"type":"message.created","message":{{"id":{id},"role":"assistant","conversationId":1,"botId":"hatbot","kind":"text","text":"{text}","status":"{status}","createdAt":"2026-10-29T10:00:00.000Z","taskId":null,"scheduleId":null,"negotiationId":null,"boxId":null,"episodeId":null,"editedAt":null,"seenAt":null}}}}"#
    )
}

#[test]
fn the_snapshot_brings_whats_live() {
    let mut store = Store::new();
    let fx = store.apply(Event::parse(SNAPSHOT));
    assert_eq!(store.bot_name(Some("hatbot")), "Hatbot");
    assert_eq!(store.pending_approvals().len(), 1);
    assert_eq!(store.pending_approvals()[0].kind, ApprovalKind::Payment);
    assert_eq!(store.unread, vec![12]);
    assert!(store.desktop.as_ref().unwrap().online);
    assert_eq!(fx, vec![Effect::RefreshTasks]);
}

#[test]
fn events_a_newer_brain_adds_are_unknown_and_change_nothing() {
    for e in [
        r#"{"type":"negotiation.updated","negotiation":{"id":1}}"#,
        r#"{"type":"teach.updated","session":{}}"#,
        r#"{"type":"plugin.updated","plugin":{"id":"x"}}"#,
        r#"{"type":"message.negotiation","id":3,"negotiationId":2}"#,
        r#"not json"#,
    ] {
        assert_eq!(Event::parse(e), Event::Unknown, "{e}");
    }
}

#[test]
fn values_a_newer_brain_adds_fall_back() {
    let e = Event::parse(
        r#"{"type":"task.updated","task":{"id":5,"botId":"hatbot","title":"Look","origin":"vision","lane":"elsewhere","status":"sleeping","createdAt":"2026-10-29T10:00:00.000Z"}}"#,
    );
    let Event::TaskUpdated { task } = e else { panic!("{e:?}") };
    assert_eq!(task.status, TaskStatus::Running);
    let a: Approval = serde_json::from_str(r#"{"id":1,"kind":"teleport","summary":"x","status":"pondering"}"#).unwrap();
    assert_eq!((a.kind, a.status), (ApprovalKind::Unknown, ApprovalStatus::Cancelled));
    let c: Conversation = serde_json::from_str(r#"{"id":2,"kind":"channel","botIds":[]}"#).unwrap();
    assert_eq!(c.kind, ConversationKind::Direct);
}

#[test]
fn a_reply_streams_into_the_open_chat_and_ends_unread() {
    let mut store = Store::new();
    store.apply(Event::parse(&message(20, "streaming", "")));
    store.apply(Event::parse(r#"{"type":"message.delta","id":20,"text":"Hel","at":0}"#));
    store.apply(Event::parse(r#"{"type":"message.delta","id":20,"text":"lo","at":3}"#));
    assert_eq!(store.text(&store.messages[0]), "Hello");
    store.apply(Event::parse(r#"{"type":"message.done","id":20,"text":"Hello.","status":"done"}"#));
    assert_eq!(store.messages[0].text, "Hello.");
    assert!(store.replies.is_empty());
    assert_eq!(store.unread, vec![20]);
}

#[test]
fn a_page_read_before_events_that_came_during_its_load_gets_them_again() {
    let mut store = Store::new();
    store.loading_page();
    store.apply(Event::parse(&message(31, "done", "after")));
    let page: Vec<ThreadMessage> = vec![serde_json::from_str(
        r#"{"id":30,"role":"user","conversationId":1,"kind":"text","text":"before","status":"done","createdAt":"2026-10-29T10:00:00.000Z"}"#,
    )
    .unwrap()];
    store.take_page(1, false, page);
    let ids: Vec<i64> = store.messages.iter().map(|m| m.id).collect();
    assert_eq!(ids, vec![30, 31]);
}

#[test]
fn messages_from_another_chat_stay_out_of_the_open_one() {
    let mut store = Store::new();
    store.open(2);
    store.apply(Event::parse(&message(40, "done", "elsewhere")));
    assert!(store.messages.is_empty());
}

#[test]
fn an_approval_answered_elsewhere_stops_waiting() {
    let mut store = Store::new();
    store.apply(Event::parse(SNAPSHOT));
    let resolved = SNAPSHOT
        .split("\"approvals\":[")
        .nth(1)
        .unwrap()
        .split("],\n \"questions\"")
        .next()
        .unwrap()
        .replace("\"pending\"", "\"approved\"");
    store.apply(Event::parse(&format!(r#"{{"type":"approval.resolved","approval":{resolved}}}"#)));
    assert_eq!(store.needs_you(), 0);
}

#[test]
fn deleting_the_open_chat_goes_back_to_another() {
    let mut store = Store::new();
    store.apply(Event::parse(SNAPSHOT));
    store.apply(Event::parse(
        r#"{"type":"conversation.updated","conversation":{"id":5,"kind":"group","title":"Team","botIds":["hatbot","coder"],"unread":0}}"#,
    ));
    store.open(5);
    let fx = store.apply(Event::parse(r#"{"type":"conversation.deleted","id":5}"#));
    assert_eq!(store.conversation_id, 1);
    assert_eq!(fx, vec![Effect::LoadThread]);
}
