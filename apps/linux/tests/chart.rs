// L6: charts in replies and on the Spend page (PLAN.md §24.2).
mod common;

use common::*;
use hatbot::core::chart::{ChartFile, Kind};
use hatbot::net::api::Api;
use hatbot::store::Store;
use serde_json::{Value, json};

#[test]
fn a_file_chart_draws_the_brains_values_and_spend_shows_without_the_charts_an_older_brain_lacks() {
    run(async {
        let brain = Brain::start();
        brain.answer(
            "GET",
            "/attachments/12/chart",
            json!({"x": ["Mon", "Tue"], "series": [{"data": [3, 5]}], "title": "Not this one"}),
        );
        let api = Api::new(brain.url(), Some(TOKEN.into()));
        let file = ChartFile::parse(r#"{"type":"bar","title":"Readings","unit":"kWh","data":12}"#)
            .unwrap();
        let answer: Value = api.get(&file.path()).await.unwrap();
        assert_eq!(
            brain.got("GET", "/attachments/12/chart")[0].query["type"],
            "bar"
        );
        let spec = file.spec(&answer).unwrap();
        assert_eq!(spec.title.as_deref(), Some("Readings"));
        let Kind::Bar(s) = spec.kind else {
            panic!("not a bar chart")
        };
        assert_eq!(
            (s.x, s.unit.as_deref()),
            (vec!["Mon".into(), "Tue".into()], Some("kWh"))
        );
        // Values that don't check out don't draw.
        assert!(
            file.spec(&json!({"x": ["Mon"], "series": [{"data": [3, 5]}]}))
                .is_none()
        );

        // Spend shows without the charts an older brain lacks.
        brain.answer(
            "GET",
            "/spend/hourly",
            json!([{"hour": "2026-10-21T09:00:00Z", "usd": 0.2, "tokens": 900}]),
        );
        brain.answer(
            "GET",
            "/spend/daily",
            json!([{"date": "2026-10-21", "usd": 1.5}]),
        );
        brain.answer(
            "GET",
            "/spend/by-model",
            json!([{"model": "claude-opus-5-5", "usd": 1.5}]),
        );
        let store = Store::new(api);
        let d = store.spend_detail().await.unwrap();
        assert_eq!(
            (d.hourly.len(), d.by_bot.len(), d.by_purpose.len()),
            (1, 0, 0)
        );
    });
}
