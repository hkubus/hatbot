use hatbot::core::chart::{
    ChartFile, ChartSpec, Kind, Part, calendar_weeks, date_range, format, listing_photo, nice_ticks, split, treemap,
    web_address, weekday,
};
use serde_json::{Value, json};

fn parses(v: Value) -> bool {
    ChartSpec::parse(&v.to_string()).is_some()
}

fn kind(v: Value) -> Kind {
    ChartSpec::parse(&v.to_string()).expect("a chart").kind
}

fn line(x: Value, series: Value) -> Value {
    json!({"type": "line", "x": x, "series": series})
}

#[test]
fn a_line_chart_takes_text_or_number_labels() {
    let Kind::Line(s) = kind(line(json!([2024, 1.5, "Mar"]), json!([{"data": [1, null, 3]}]))) else { panic!() };
    assert_eq!(s.x, ["2024", "1.5", "Mar"]);
}

#[test]
fn a_series_needs_one_value_per_x() {
    assert!(!parses(line(json!(["a", "b"]), json!([{"data": [1]}]))));
    assert!(!parses(line(json!(["a"]), json!([{"data": [1, 2]}]))));
}

#[test]
fn a_chart_needs_a_value() {
    assert!(!parses(line(json!(["a", "b"]), json!([{"data": [null, null]}]))));
}

#[test]
fn at_most_three_series() {
    let three = json!([{"data": [1]}, {"data": [1]}, {"data": [1]}]);
    assert!(parses(line(json!(["a"]), three)));
    let four = json!([{"data": [1]}, {"data": [1]}, {"data": [1]}, {"data": [1]}]);
    assert!(!parses(line(json!(["a"]), four)));
}

#[test]
fn an_optional_field_may_be_left_out_but_not_null() {
    assert!(!parses(line(json!(["a"]), json!([{"name": null, "data": [1]}]))));
    assert!(!parses(json!({"type": "bar", "title": null, "x": ["a"], "series": [{"data": [1]}]})));
    assert!(!parses(json!({"type": "bar", "stacked": null, "x": ["a"], "series": [{"data": [1]}]})));
    assert!(!parses(json!({"type": "range", "rows": [{"label": "a", "low": 1, "high": 2, "mark": null}]})));
}

#[test]
fn values_and_a_file_together_are_refused() {
    assert!(!parses(json!({"type": "bar", "data": 3, "x": ["a"], "series": [{"data": [1]}]})));
    assert!(!parses(json!({"type": "meter", "data": null, "rows": [{"label": "a", "value": 1, "max": 2}]})));
}

#[test]
fn lengths_are_counted_as_javascript_counts_them() {
    // An emoji is two UTF-16 units: sixty make a title of 120.
    let title = |n: usize| json!({"type": "line", "title": "🐈".repeat(n), "x": ["a"], "series": [{"data": [1]}]});
    assert!(parses(title(60)));
    assert!(!parses(title(61)));
}

#[test]
fn horizontal_bars_are_fewer_than_columns() {
    let bars = |n: usize, horizontal: bool| json!({"type": "bar", "horizontal": horizontal, "x": vec!["a"; n], "series": [{"data": vec![1; n]}]});
    assert!(parses(bars(41, false)));
    assert!(parses(bars(40, true)));
    assert!(!parses(bars(41, true)));
}

#[test]
fn reference_lines_are_few_and_named() {
    let refs = |r: Value| json!({"type": "bar", "x": ["a"], "series": [{"data": [1]}], "refs": r});
    let one = json!({"value": 1, "label": "Limit"});
    assert!(parses(refs(json!([one, one, one]))));
    assert!(!parses(refs(json!([one, one, one, one]))));
    assert!(!parses(refs(json!([{"value": 1, "label": ""}]))));
}

#[test]
fn a_scatter_has_at_most_500_points_and_named_ones_have_names() {
    let points = |n: usize| json!([{"points": vec![json!({"x": 1, "y": 2}); n]}]);
    assert!(parses(json!({"type": "scatter", "series": points(500)})));
    assert!(!parses(json!({"type": "scatter", "series": points(501)})));
    assert!(!parses(json!({"type": "scatter", "series": [{"points": []}]})));
    assert!(!parses(json!({"type": "scatter", "series": [{"points": [{"x": 1, "y": 2, "label": ""}]}]})));
}

#[test]
fn a_range_runs_low_to_high_with_its_mark_inside() {
    let range = |row: Value| json!({"type": "range", "rows": [row]});
    assert!(parses(range(json!({"label": "a", "low": 1, "high": 3, "mark": 2}))));
    assert!(!parses(range(json!({"label": "a", "low": 3, "high": 1}))));
    assert!(!parses(range(json!({"label": "a", "low": 1, "high": 3, "mark": 4}))));
}

#[test]
fn a_matrix_has_a_value_per_row_and_column_shaded_by_which_end_is_better() {
    assert!(!parses(json!({"type": "matrix", "rows": ["a", "b"], "columns": [{"name": "P"}], "values": [[1]]})));
    assert!(!parses(json!({"type": "matrix", "rows": ["a"], "columns": [{"name": "P"}], "values": [[1, 2]]})));
    let Kind::Matrix(m) = kind(json!({
        "type": "matrix", "rows": ["a", "b", "c"],
        "columns": [{"name": "Price", "better": "low"}, {"name": "Same"}],
        "values": [[1, 5], [2, 5], [null, 5]]
    })) else {
        panic!()
    };
    assert_eq!((0..3).map(|r| m.shade(r, 0)).collect::<Vec<_>>(), [Some(1.0), Some(0.0), None]);
    assert_eq!(m.shade(0, 1), None);
}

#[test]
fn a_timeline_has_real_dates_in_order_and_few_lanes() {
    let events = |e: Value| json!({"type": "timeline", "events": e});
    assert!(parses(events(
        json!([{"date": "2024", "label": "a"}, {"date": "2024-03-15", "end": "2024-04", "label": "b"}])
    )));
    assert!(!parses(events(json!([{"date": "2024-13", "label": "a"}]))));
    assert!(!parses(events(json!([{"date": "24-01", "label": "a"}]))));
    assert!(!parses(events(json!([{"date": "2024-03", "end": "2024-02", "label": "a"}]))));
    // A month's span ends on its last day, so a day in it doesn't end before it.
    assert!(parses(events(json!([{"date": "2024-03", "end": "2024-03-31", "label": "a"}]))));
    let lanes = |n: usize| {
        events(json!((0..n).map(|i| json!({"date": "2024", "label": "a", "lane": i.to_string()})).collect::<Vec<_>>()))
    };
    assert!(parses(lanes(8)));
    assert!(!parses(lanes(9)));
}

#[test]
fn a_date_covers_its_whole_month_or_year() {
    assert_eq!(date_range("2024-02").map(|(a, b)| b - a + 1), Some(29));
    assert_eq!(date_range("2023").map(|(a, b)| b - a + 1), Some(365));
    assert_eq!(date_range("1970-01-02"), Some((1, 1)));
    // Past a month's end rolls on, as JavaScript's Date.UTC does.
    assert_eq!(date_range("2023-02-30"), date_range("2023-03-02"));
}

#[test]
fn a_listing_links_to_the_web_and_shows_only_https_photos() {
    let item = |it: Value| json!({"type": "listings", "items": [it]});
    assert!(parses(item(json!({"title": "Sofa", "url": "https://olx.pl/d/1", "photo": "https://x.olxcdn.com/a.jpg"}))));
    assert!(!parses(item(json!({"title": "Sofa", "url": "javascript:alert(1)"}))));
    assert!(!parses(item(json!({"title": "Sofa", "url": "ftp://olx.pl/1"}))));
    assert!(!parses(item(json!({"title": "Sofa", "url": "https://olx.pl/1", "photo": "http://x.olxcdn.com/a.jpg"}))));
    assert!(!parses(item(json!({"title": "", "url": "https://olx.pl/1"}))));
    assert!(!parses(item(json!({"title": "a".repeat(201), "url": "https://olx.pl/1"}))));
}

#[test]
fn only_the_marketplaces_photos_are_fetched() {
    assert!(web_address("HTTP://example.com/a", false));
    assert!(!web_address("http://example.com/a", true));
    assert!(!web_address("https://", false));
    assert!(listing_photo("https://ireland.apollo.olxcdn.com/v1/files/a/image"));
    assert!(listing_photo("https://allegroimg.com/a.jpg"));
    assert!(!listing_photo("https://evil.com/?x=olxcdn.com"));
    assert!(!listing_photo("https://notolxcdn.com/a.jpg"));
    assert!(!listing_photo("https://x.olxcdn.com:8443/a.jpg"));
    assert!(!listing_photo("https://me:pw@x.olxcdn.com/a.jpg"));
    assert!(!listing_photo("http://x.olxcdn.com/a.jpg"));
}

#[test]
fn a_listing_says_where_it_is() {
    let Kind::Listings(l) = kind(json!({"type": "listings", "items": [
        {"title": "a", "url": "https://www.olx.pl/d/1", "note": "Kraków"},
        {"title": "b", "url": "https://olx.pl/d/2", "site": "OLX"}
    ]})) else {
        panic!()
    };
    assert_eq!(l.items[0].place(), "olx.pl · Kraków");
    assert_eq!(l.items[1].place(), "OLX");
}

#[test]
fn a_meter_warns_from_its_warning_and_past_its_max() {
    let meter = |row: Value| json!({"type": "meter", "rows": [row]});
    assert!(!parses(meter(json!({"label": "a", "value": 1, "max": 2, "warn": 3}))));
    assert!(!parses(meter(json!({"label": "a", "value": -1, "max": 2}))));
    assert!(!parses(meter(json!({"label": "a", "value": 1, "max": 0}))));
    let Kind::Meter(m) = kind(json!({"type": "meter", "rows": [
        {"label": "a", "value": 8, "max": 10, "warn": 8},
        {"label": "b", "value": 11, "max": 10},
        {"label": "c", "value": 5, "max": 10, "warn": 8}
    ]})) else {
        panic!()
    };
    assert_eq!(m.rows.iter().map(|r| r.warning()).collect::<Vec<_>>(), [true, true, false]);
}

#[test]
fn a_calendar_has_each_day_once_within_a_year() {
    let days = |d: Vec<&str>| json!({"type": "calendar", "days": d.into_iter().map(|d| json!({"date": d, "value": 1})).collect::<Vec<_>>()});
    assert!(parses(days(vec!["2024-01-01", "2024-12-31"])));
    assert!(!parses(days(vec!["2024-01-01", "2024-01-01"])));
    assert!(!parses(days(vec!["2024-01"])));
    assert!(!parses(days(vec!["2024-01-01", "2025-06-01"])));
}

#[test]
fn calendar_weeks_start_on_monday_and_reach_the_last_day() {
    // 2024-01-03 is a Wednesday; 2024-01-15 a Monday.
    let weeks = calendar_weeks(&["2024-01-15", "2024-01-03"]);
    assert_eq!(weeks.len(), 3);
    assert!(weeks.iter().all(|w| weekday(w[0]) == 0));
    assert_eq!(weeks[0][2], date_range("2024-01-03").unwrap().0);
    assert_eq!(weeks[2][0], date_range("2024-01-15").unwrap().0);
}

#[test]
fn a_treemap_takes_positive_values() {
    assert!(parses(json!({"type": "treemap", "items": [{"label": "a", "value": 1}]})));
    assert!(!parses(json!({"type": "treemap", "items": [{"label": "a", "value": 0}]})));
}

#[test]
fn treemap_tiles_fill_the_area_without_overlapping() {
    let values = [6.0, 6.0, 4.0, 3.0, 2.0, 2.0, 1.0];
    let tiles = treemap(&values, 600.0, 400.0);
    assert_eq!(tiles.len(), values.len());
    let total: f64 = values.iter().sum();
    for t in &tiles {
        assert!((t.w * t.h - values[t.i] / total * 600.0 * 400.0).abs() < 1e-6);
        assert!(t.x >= -1e-9 && t.y >= -1e-9 && t.x + t.w <= 600.0 + 1e-6 && t.y + t.h <= 400.0 + 1e-6);
    }
    for (k, a) in tiles.iter().enumerate() {
        for b in &tiles[k + 1..] {
            let overlap = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x);
            let overlap = overlap.min((a.y + a.h).min(b.y + b.h) - a.y.max(b.y));
            assert!(overlap < 1e-6, "{a:?} overlaps {b:?}");
        }
    }
    // Largest first, from the top left.
    assert_eq!((tiles[0].i, tiles[0].x, tiles[0].y), (0, 0.0, 0.0));
}

#[test]
fn a_comparison_has_two_to_four_columns_and_a_best_among_them() {
    let compare = |cols: Value, row: Value| json!({"type": "compare", "columns": cols, "rows": [row]});
    assert!(parses(compare(json!(["a", "b"]), json!({"label": "x", "values": ["1", null], "best": 1.0}))));
    assert!(!parses(compare(json!(["a"]), json!({"label": "x", "values": ["1"]}))));
    assert!(!parses(compare(json!(["a", "b"]), json!({"label": "x", "values": ["1", "2"], "best": 2}))));
    assert!(!parses(compare(json!(["a", "b"]), json!({"label": "x", "values": ["1", "2"], "best": 0.5}))));
    assert!(!parses(compare(json!(["a", "b"]), json!({"label": "x", "values": ["1"]}))));
    let Kind::Compare(c) = kind(json!({"type": "compare", "columns": ["a", "b", "c"], "rows": [
        {"label": "x", "values": ["4", null, "4"]},
        {"label": "y", "values": ["4", "5", "4"]},
        {"label": "z", "values": ["4", null, null]}
    ]})) else {
        panic!()
    };
    assert_eq!(c.rows.iter().map(|r| r.alike()).collect::<Vec<_>>(), [true, false, false]);
}

#[test]
fn offers_are_prices_from_zero_by_you_or_them() {
    let offers = |extra: Value| {
        let mut o = json!({"type": "offers", "offers": [{"by": "you", "price": 10}]});
        o.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        o
    };
    assert!(parses(offers(json!({"limit": 20}))));
    assert!(!parses(offers(json!({"them": ""}))));
    assert!(!parses(json!({"type": "offers", "offers": [{"by": "you", "price": -1}]})));
    assert!(!parses(json!({"type": "offers", "offers": [{"by": "me", "price": 1}]})));
    let Kind::Offers(o) = kind(offers(json!({}))) else { panic!() };
    assert_eq!(o.them_name(), "Them");
}

#[test]
fn a_gallery_has_https_photos_and_not_too_many() {
    let gallery = |photos: Vec<&str>| json!({"type": "gallery", "url": "https://olx.pl/d/1", "photos": photos});
    assert!(parses(gallery(vec!["https://x.olxcdn.com/a.jpg"; 20])));
    assert!(!parses(gallery(vec!["https://x.olxcdn.com/a.jpg"; 21])));
    assert!(!parses(gallery(vec!["http://x.olxcdn.com/a.jpg"])));
    assert!(!parses(gallery(vec![])));
}

#[test]
fn an_unknown_kind_is_refused() {
    assert!(!parses(json!({"type": "pie", "x": ["a"], "series": [{"data": [1]}]})));
}

#[test]
fn values_read_as_the_web_writes_them() {
    assert_eq!(format(1284.0, None, false), "1,284");
    assert_eq!(format(12_900.0, None, true), "12.9K");
    assert_eq!(format(999_950.0, None, true), "1M");
    assert_eq!(format(0.425, None, false), "0.42");
    assert_eq!(format(2.5, None, false), "2.5");
    assert_eq!(format(4.2, Some("$"), false), "$4.20");
    assert_eq!(format(4.0, Some("$"), false), "$4");
    assert_eq!(format(-4.2e6, Some("€"), true), "-€4.2M");
    assert_eq!(format(87.0, Some("%"), false), "87%");
    assert_eq!(format(3.1234, Some("GiB"), false), "3.12 GiB");
    assert_eq!(format(150.5, None, false), "151");
}

#[test]
fn ticks_are_round_and_cover_the_values() {
    assert_eq!(nice_ticks(0.0, 87.0, 4), [0.0, 25.0, 50.0, 75.0, 100.0]);
    assert_eq!(nice_ticks(0.1, 0.3, 4), [0.1, 0.15, 0.2, 0.25, 0.3]);
    let flat = nice_ticks(5.0, 5.0, 4);
    assert!(flat[0] < 5.0 && *flat.last().unwrap() > 5.0);
}

#[test]
fn stacked_bars_go_up_from_zero_and_negatives_down() {
    let Kind::Bar(s) = kind(json!({"type": "bar", "stacked": true, "x": ["a", "b"], "series": [
        {"name": "In", "data": [3, null]}, {"data": [-2, 4]}, {"data": [1, 0]}
    ]})) else {
        panic!()
    };
    assert!(s.is_stacked(true));
    assert_eq!(
        s.stack_spans(),
        [vec![Some((0.0, 3.0)), Some((0.0, -2.0)), Some((3.0, 4.0))], vec![None, Some((0.0, 4.0)), None]]
    );
    assert_eq!(s.stack_totals(), [Some(2.0), Some(4.0)]);
    assert_eq!(s.names(), ["In", "Series 2", "Series 3"]);
}

#[test]
fn a_file_chart_draws_the_brains_values_under_its_own_title() {
    let f = ChartFile::parse(r#"{"type":"line","title":"CPU","unit":"%","data":7}"#).unwrap();
    assert_eq!(f.path(), "/attachments/7/chart?type=line");
    let spec = f.spec(br#"{"title":"Not this","x":["a"],"series":[{"data":[3]}]}"#).unwrap();
    assert_eq!(spec.title.as_deref(), Some("CPU"));
    assert!(f.spec(br#"{"x":["a"],"series":[{"data":[3,4]}]}"#).is_none());
    // Values as well, a kind that can't, no file and a block that doesn't check out.
    assert!(ChartFile::parse(r#"{"type":"line","data":7,"x":["a"]}"#).is_none());
    assert!(ChartFile::parse(r#"{"type":"range","data":7}"#).is_none());
    assert!(ChartFile::parse(r#"{"type":"bar","data":0}"#).is_none());
    assert!(ChartFile::parse(r#"{"type":"bar","data":7,"unit":"thirteen chars"}"#).is_none());
    assert!(ChartFile::parse(r#"{"type":"scatter","data":7,"xName":"Price"}"#).is_some());
}

const CHART: &str = r#"{"type":"bar","x":["a"],"series":[{"data":[1]}]}"#;

#[test]
fn a_reply_is_cut_at_its_chart_blocks() {
    let text = format!(
        "Here:\n\n```chart\n{CHART}\n```\n\nAnd a file:\n~~~~ chart\n{{\"type\":\"line\",\"data\":3}}\n~~~~\nDone."
    );
    let parts = split(&text, false);
    assert!(
        matches!(&parts[..], [Part::Markdown(a), Part::Chart(_), Part::Markdown(b), Part::File(_), Part::Markdown(c)]
        if a == "Here:\n" && b == "\nAnd a file:" && c == "Done.")
    );
}

#[test]
fn a_chart_block_that_doesnt_draw_stays_code() {
    let text = format!("Before\n```chart\n{{\"type\":\"pie\"}}\n```\nAfter\n```chart\n{CHART}\n```");
    let parts = split(&text, false);
    assert!(matches!(&parts[..], [Part::Markdown(md), Part::Chart(_)]
        if md == "Before\n```chart\n{\"type\":\"pie\"}\n```\nAfter"));
}

#[test]
fn a_chart_still_streaming_in_is_pending() {
    let text = "Here:\n```chart\n{\"type\":\"bar\",\"x\":[";
    assert!(matches!(&split(text, true)[..], [Part::Markdown(_), Part::Pending]));
    assert!(matches!(&split(text, false)[..], [Part::Markdown(md)] if md == text));
}

#[test]
fn a_fence_closes_only_with_its_own_character_at_least_as_long() {
    // ``` inside a ```` block, ~~~ inside a ``` one, and a fence with words after it don't close it.
    let text = format!("````chart\n{CHART}\n```\n````");
    assert!(matches!(&split(&text, false)[..], [Part::Markdown(_)]));
    let text = format!("```chart\n{CHART}\n~~~\n``` not yet\n```");
    assert!(matches!(&split(&text, false)[..], [Part::Markdown(_)]));
    let text = format!("```chart\n{CHART}\n`````");
    assert!(matches!(&split(&text, false)[..], [Part::Chart(_)]));
}

#[test]
fn a_chart_fence_inside_another_code_block_is_left_alone() {
    let text = format!("~~~md\n```chart\n{CHART}\n```\n~~~");
    assert!(matches!(&split(&text, false)[..], [Part::Markdown(md)] if *md == text));
}
