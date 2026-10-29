use hatbot::core::format;

#[test]
fn a_due_date_must_be_a_real_date() {
    assert_eq!(format::ymd(" 2026-11-02 ").as_deref(), Some("2026-11-02"));
    assert_eq!(format::ymd("2026-02-30"), None);
    assert_eq!(format::ymd("next friday"), None);
}

#[test]
fn a_due_date_in_the_past_is_overdue() {
    assert!(format::due("2020-01-01", None).1);
    assert!(!format::due("2999-01-01", None).1);
}

#[test]
fn a_schedule_cannot_be_set_in_the_past() {
    assert_eq!(format::local_to_iso("2020-01-01 08:00"), None);
    assert!(format::local_to_iso("2999-01-01 08:00").is_some());
    assert_eq!(format::local_to_iso("tomorrow"), None);
}

#[test]
fn a_search_snippet_marks_its_matches() {
    assert_eq!(
        format::snippet("the \u{2}flat\u{3} near \u{2}park"),
        vec![("the ", false), ("flat", true), (" near ", false), ("park", true)]
    );
}

#[test]
fn an_amount_is_read_as_typed() {
    assert_eq!(format::amount("$12.50"), Some(12.5));
    assert_eq!(format::amount("12,5"), Some(12.5));
    assert_eq!(format::amount(""), None);
    assert_eq!(format::amount("lots"), None);
}

#[test]
fn a_spending_limit_of_nothing_is_refused() {
    use hatbot::core::models::Limits;
    let ok = Limits {
        task_usd: 1.0,
        research_usd: 2.0,
        daily_usd: 5.0,
        monthly_usd: 50.0,
        alert_reserve_usd: Some(0.0),
        boxes_usd: Some(0.0),
    };
    assert!(ok.valid());
    assert!(!Limits { daily_usd: 0.0, ..ok.clone() }.valid());
    assert!(!Limits { boxes_usd: Some(-1.0), ..ok }.valid());
}
