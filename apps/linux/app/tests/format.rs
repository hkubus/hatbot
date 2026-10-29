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
