// L5: memory and proposals (PLAN.md §23.2).
mod common;

use common::*;
use hatbot::core::models::{MemoryConflict, ProposalStatus};
use hatbot::net::api::Api;
use hatbot::store::{Store, conflict};
use serde_json::json;

#[test]
fn a_save_after_someone_elses_shows_theirs_then_overwrites_and_a_proposal_is_applied() {
    run(async {
        let brain = Brain::start();
        // Someone saved "s2" after the copy you were editing.
        brain.route("PUT", "/memory/file", |req| {
            match req.body["baseSha"].as_str() {
                Some("s2") => (200, json!({"sha": "s3"})),
                _ => (
                    409,
                    json!({"error": "changed", "sha": "s2", "content": "theirs"}),
                ),
            }
        });
        let proposal = |status: &str| {
            json!({
                "id": 1, "kind": "skill", "title": "Wait for the login form", "reason": "Two runs typed too soon.",
                "changes": [{"path": "skills/nas.md", "before": "a\n", "after": "a\nb\n"}],
                "skill": "nas", "status": status, "createdAt": "2026-10-20T08:00:00.000Z"
            })
        };
        brain.answer("GET", "/proposals", json!([proposal("pending")]));
        brain.answer(
            "POST",
            "/proposals/1/apply",
            json!({"proposal": proposal("applied"), "sha": "s4"}),
        );
        let store = Store::new(Api::new(brain.url(), Some(TOKEN.into())));

        let e = store
            .save_memory("notes/a b.md", "mine", "s1")
            .await
            .unwrap_err();
        let theirs = conflict(&e).unwrap();
        assert_eq!(
            theirs,
            MemoryConflict {
                sha: "s2".into(),
                content: "theirs".into()
            }
        );
        let sha = store
            .save_memory("notes/a b.md", "mine", &theirs.sha)
            .await
            .unwrap();
        assert_eq!(sha.as_deref(), Some("s3"));
        let saves = brain.got("PUT", "/memory/file");
        assert_eq!(saves[1].query["path"], "notes/a b.md");
        assert_eq!(saves[1].body["content"], "mine");

        store.load_proposals().await.unwrap();
        assert_eq!(store.state().proposals[&1].status, ProposalStatus::Pending);
        store.resolve_proposal(1, true).await.unwrap();
        assert_eq!(store.state().proposals[&1].status, ProposalStatus::Applied);
    });
}
