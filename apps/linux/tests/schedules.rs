mod common;

use common::*;
use hatbot::core::schedule::ScheduleForm;
use hatbot::net::api::Api;
use hatbot::store::Store;
use serde_json::{Value, json};

fn schedule(id: i64) -> Value {
    json!({
        "id": id, "botId": "hatbot", "name": "Call mum", "cron": null, "runAt": "2026-10-21T17:00:00.000Z",
        "prompt": "Remind me to ring her", "enabled": true, "createdVia": "owner", "createdAt": "2026-10-20T10:00:00.000Z",
        "nextRunAt": "2026-10-21T17:00:00.000Z", "lastRunAt": null, "lastTaskId": null, "tainted": false, "taintedBy": null
    })
}

fn trigger(enabled: bool) -> Value {
    json!({
        "id": 1, "botId": "hatbot", "name": "NAS alerts", "kind": "kuma", "trusted": true, "prompt": "Find out why",
        "enabled": enabled, "confirmChecks": 1, "url": "https://hatbot.example/api/v1/hooks/kuma/1",
        "createdAt": "2026-10-20T10:00:00.000Z", "lastFiredAt": null, "lastTaskId": null
    })
}

#[test]
fn a_schedule_is_added_run_and_deleted_and_a_trigger_switched_off_and_given_a_new_secret() {
    run(async {
        let brain = Brain::start();
        brain.answer("GET", "/schedules", json!([]));
        brain.answer("GET", "/triggers", json!([trigger(true)]));
        brain.route("POST", "/schedules", |_| (201, schedule(40)));
        brain.route("POST", "/schedules/40/run", |_| {
            (
                201,
                json!({
                    "id": 90, "botId": "hatbot", "conversationId": null, "title": "Call mum", "goal": "Remind me",
                    "successCriteria": "", "origin": "schedule", "lane": "background", "source": null, "parentId": null,
                    "model": "claude-haiku-5-5", "status": "queued", "tainted": false, "summary": null, "costUsd": 0,
                    "steps": 0, "createdAt": "2026-10-20T10:00:00.000Z", "startedAt": null, "finishedAt": null
                }),
            )
        });
        brain.answer("DELETE", "/schedules/40", json!({"ok": true}));
        brain.answer("PATCH", "/triggers/1", trigger(false));
        brain.route("POST", "/triggers/1/secret", |_| {
            let mut t = trigger(false);
            t["secret"] = json!("s3cret");
            (200, t)
        });
        let store = Store::new(Api::new(brain.url(), Some(TOKEN.into())));

        store.load_schedules().await.unwrap();
        assert!(store.state().triggers[&1].enabled);

        let form = ScheduleForm {
            name: " Call mum ".into(),
            prompt: "Remind me to ring her".into(),
            repeats: false,
            ..ScheduleForm::default()
        };
        let added = store.save_schedule(None, &form.change()).await.unwrap();
        let sent = &brain.got("POST", "/schedules")[0].body;
        assert_eq!(sent["name"], "Call mum");
        assert!(sent.get("cron").is_none() && sent["at"].is_string());
        assert!(store.state().schedules.contains_key(&added.id));

        let task = store.run_schedule(40).await.unwrap();
        assert!(store.state().tasks.contains_key(&task.id));
        store.delete_schedule(40).await.unwrap();
        assert!(!store.state().schedules.contains_key(&40));

        store
            .update_trigger(1, &json!({"enabled": false}))
            .await
            .unwrap();
        assert_eq!(
            brain.got("PATCH", "/triggers/1")[0].body,
            json!({"enabled": false})
        );
        assert!(!store.state().triggers[&1].enabled);
        let fresh = store.new_secret(1).await.unwrap();
        assert_eq!(fresh.secret, "s3cret");
    });
}
