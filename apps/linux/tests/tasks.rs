// L3: tasks (PLAN.md §24.2).
mod common;

use common::*;
use hatbot::core::models::TaskStatus;
use hatbot::net::api::Api;
use hatbot::store::Store;
use serde_json::{Value, json};

#[test]
fn finished_tasks_page_back_and_one_runs_again_with_a_new_goal() {
    run(async {
        let brain = Brain::start();
        brain.route("GET", "/tasks", |r| {
            let before: i64 = r.query.get("before").map_or(201, |b| b.parse().unwrap());
            let page: Vec<Value> = (1..before)
                .rev()
                .take(50)
                .map(|id| task(id, "done"))
                .collect();
            (200, json!(page))
        });
        brain.route("POST", "/tasks/150/rerun", |_| (201, task(201, "queued")));
        let store = Store::new(Api::new(brain.url(), Some(TOKEN.into())));

        let first = store.load_tasks(true, None).await.unwrap();
        assert_eq!((first[0], first.len()), (200, 50));
        let next = store.load_tasks(true, first.last().copied()).await.unwrap();
        assert_eq!(next[0], 150);
        let asked = brain.got("GET", "/tasks");
        assert_eq!(asked[0].query["status"], "done");
        assert_eq!(asked[1].query["before"], "151");

        let again = store
            .rerun_task(150, Some("Water the plants and the herbs"))
            .await
            .unwrap();
        assert_eq!(again.id, 201);
        assert_eq!(store.state().tasks[&201].status, TaskStatus::Queued);
        // The goal goes only when you changed it.
        store.rerun_task(150, None).await.unwrap();
        let sent = brain.got("POST", "/tasks/150/rerun");
        assert_eq!(
            sent[0].body,
            json!({"goal": "Water the plants and the herbs"})
        );
        assert_eq!(sent[1].body, json!({}));
    });
}
