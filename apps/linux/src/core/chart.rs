// Charts in replies: a ```chart fenced block holding this JSON (packages/shared/src/chart.ts, Chart.swift
// on iOS). Line and bar keep their values in `x` and `series`; scatter, range, matrix and timeline each
// in their own fields. One that doesn't check out stays a code block. A line, bar or scatter block can
// name an attachment for its values instead (ChartFile).
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};

/// Past three series the colours stop telling apart for colour-blind readers.
pub const MAX_SERIES: usize = 3;
pub const MAX_POINTS: usize = 500;
/// Horizontal bars and ranges take a row each, so fewer of them.
pub const MAX_ROWS: usize = 40;
pub const MAX_COLUMNS: usize = 8;
pub const MAX_EVENTS: usize = 60;
pub const MAX_LANES: usize = 8;

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct ChartSpec {
    #[serde(default, deserialize_with = "present")]
    pub title: Option<String>,
    #[serde(flatten)]
    pub kind: Kind,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Kind {
    Line(Series),
    Bar(Series),
    Scatter(Scatter),
    Range(Ranges),
    Matrix(Matrix),
    Timeline(Timeline),
}

/// Line and bar: one value per x for each series.
#[derive(Deserialize, Debug, Clone, PartialEq, Default)]
pub struct Series {
    /// "%", "GiB", "ms", or a currency symbol ("$", "€"), which goes in front.
    #[serde(default, deserialize_with = "present")]
    pub unit: Option<String>,
    /// Bars: the series stack into one bar per x, as parts of its total.
    #[serde(default, deserialize_with = "flag")]
    pub stacked: bool,
    /// Bars: one row per x, for rankings and long names.
    #[serde(default, deserialize_with = "flag")]
    pub horizontal: bool,
    #[serde(deserialize_with = "labels")]
    pub x: Vec<String>,
    pub series: Vec<Line>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Line {
    #[serde(default, deserialize_with = "present")]
    pub name: Option<String>,
    /// One value per x; None is a gap.
    pub data: Vec<Option<f64>>,
}

/// Points on two measured axes, for trade-offs (price against noise).
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Scatter {
    #[serde(default, deserialize_with = "present")]
    pub x_name: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub x_unit: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub y_name: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub y_unit: Option<String>,
    pub series: Vec<Points>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Points {
    #[serde(default, deserialize_with = "present")]
    pub name: Option<String>,
    pub points: Vec<Point>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
    #[serde(default, deserialize_with = "present")]
    pub label: Option<String>,
}

/// A span from low to high for each row (prices across shops), with an optional mark inside it.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ranges {
    #[serde(default, deserialize_with = "present")]
    pub unit: Option<String>,
    /// What the mark is: "median", "cheapest new".
    #[serde(default, deserialize_with = "present")]
    pub mark_name: Option<String>,
    pub rows: Vec<RangeRow>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct RangeRow {
    pub label: String,
    pub low: f64,
    pub high: f64,
    #[serde(default, deserialize_with = "present")]
    pub mark: Option<f64>,
}

/// Options against criteria, a value in each cell; each column is shaded from its worst to its best.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Matrix {
    pub rows: Vec<String>,
    pub columns: Vec<Column>,
    /// One list per row, a value per column; None where it isn't known.
    pub values: Vec<Vec<Option<f64>>>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Column {
    pub name: String,
    #[serde(default, deserialize_with = "present")]
    pub unit: Option<String>,
    /// Which end is better: low for prices and noise. Higher is better by default.
    #[serde(default, deserialize_with = "present")]
    pub better: Option<Better>,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Better {
    High,
    Low,
}

/// Dated events, or spans with an end, in order along one axis; lanes split them into rows.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Timeline {
    pub events: Vec<Event>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Event {
    /// 2024, 2024-03 or 2024-03-15.
    pub date: String,
    #[serde(default, deserialize_with = "present")]
    pub end: Option<String>,
    pub label: String,
    #[serde(default, deserialize_with = "present")]
    pub lane: Option<String>,
}

/// A field the spec makes optional may be left out, but not sent as null.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

fn flag<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    bool::deserialize(d)
}

/// x labels are strings or numbers.
fn labels<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Label {
        Text(String),
        Number(f64),
    }
    Ok(Vec::<Label>::deserialize(d)?
        .into_iter()
        .map(|l| match l {
            Label::Text(s) => s,
            Label::Number(n) if n == n.round() && n.abs() < 1e15 => (n as i64).to_string(),
            Label::Number(n) => n.to_string(),
        })
        .collect())
}

/// Lengths are counted as JavaScript does.
fn fits(s: Option<&str>, max: usize) -> bool {
    s.is_none_or(|s| s.encode_utf16().count() <= max)
}

fn is_label(s: Option<&str>) -> bool {
    s.is_none_or(|s| (1..=60).contains(&s.encode_utf16().count()))
}

impl ChartSpec {
    /// The spec in a chart block, or None if it isn't one.
    pub fn parse(source: &str) -> Option<ChartSpec> {
        let json: Value = serde_json::from_str(source).ok()?;
        Self::from_value(json)
    }

    fn from_value(json: Value) -> Option<ChartSpec> {
        // Values typed in and a file as well: which one is meant isn't clear, so neither is drawn.
        if json.get("data").is_some() {
            return None;
        }
        let spec: ChartSpec = serde_json::from_value(json).ok()?;
        spec.checks_out().then_some(spec)
    }

    /// The shared spec's limits and rules, for the kind it is.
    fn checks_out(&self) -> bool {
        if !fits(self.title.as_deref(), 120) {
            return false;
        }
        match &self.kind {
            Kind::Line(s) | Kind::Bar(s) => {
                let bar = matches!(self.kind, Kind::Bar(_));
                fits(s.unit.as_deref(), 12)
                    && (1..=MAX_POINTS).contains(&s.x.len())
                    && s.x.iter().all(|x| fits(Some(x), 60))
                    && (1..=MAX_SERIES).contains(&s.series.len())
                    && s.series
                        .iter()
                        .all(|l| fits(l.name.as_deref(), 60) && l.data.len() == s.x.len())
                    && s.series.iter().any(|l| l.data.iter().any(Option::is_some))
                    && !(bar && s.horizontal && s.x.len() > MAX_ROWS)
            }
            Kind::Scatter(s) => {
                fits(s.x_name.as_deref(), 60)
                    && fits(s.x_unit.as_deref(), 12)
                    && fits(s.y_name.as_deref(), 60)
                    && fits(s.y_unit.as_deref(), 12)
                    && (1..=MAX_SERIES).contains(&s.series.len())
                    && s.series.iter().all(|se| {
                        fits(se.name.as_deref(), 60)
                            && !se.points.is_empty()
                            && se.points.iter().all(|p| is_label(p.label.as_deref()))
                    })
                    && s.series.iter().map(|se| se.points.len()).sum::<usize>() <= MAX_POINTS
            }
            Kind::Range(r) => {
                fits(r.unit.as_deref(), 12)
                    && fits(r.mark_name.as_deref(), 60)
                    && (1..=MAX_ROWS).contains(&r.rows.len())
                    && r.rows.iter().all(|row| {
                        is_label(Some(&row.label))
                            && row.low <= row.high
                            && row.mark.is_none_or(|m| m >= row.low && m <= row.high)
                    })
            }
            Kind::Matrix(m) => {
                (1..=MAX_ROWS).contains(&m.rows.len())
                    && m.rows.iter().all(|r| is_label(Some(r)))
                    && (1..=MAX_COLUMNS).contains(&m.columns.len())
                    && m.columns
                        .iter()
                        .all(|c| is_label(Some(&c.name)) && fits(c.unit.as_deref(), 12))
                    && m.values.len() == m.rows.len()
                    && m.values.iter().all(|r| r.len() == m.columns.len())
            }
            Kind::Timeline(t) => {
                (1..=MAX_EVENTS).contains(&t.events.len())
                    && t.events.iter().all(|e| {
                        let Some((start, _)) = date_range(&e.date) else {
                            return false;
                        };
                        is_label(Some(&e.label))
                            && fits(e.lane.as_deref(), 40)
                            && e.end.as_deref().is_none_or(|end| {
                                date_range(end).is_some_and(|(_, last)| start <= last)
                            })
                    })
                    && t.lanes().len() <= MAX_LANES
            }
        }
    }
}

impl Series {
    /// Whether the bars stack: asked for, and more than one series to stack.
    pub fn is_stacked(&self, bar: bool) -> bool {
        bar && self.stacked && self.series.len() > 1
    }

    /// Series names, with "Series 2" for one Hatbot left unnamed.
    pub fn names(&self) -> Vec<String> {
        names(self.series.iter().map(|s| s.name.as_deref()))
    }

    /// Each x's stack of bars: (start, end) per series, positives up from 0 and negatives down.
    pub fn stack_spans(&self) -> Vec<Vec<Option<(f64, f64)>>> {
        (0..self.x.len())
            .map(|i| {
                let (mut up, mut down) = (0.0, 0.0);
                self.series
                    .iter()
                    .map(|se| {
                        let v = se.data[i].filter(|v| *v != 0.0)?;
                        let start = if v > 0.0 { up } else { down };
                        if v > 0.0 {
                            up += v;
                        } else {
                            down += v;
                        }
                        Some((start, start + v))
                    })
                    .collect()
            })
            .collect()
    }

    /// The sum at each x, or None where every series is a gap.
    pub fn stack_totals(&self) -> Vec<Option<f64>> {
        (0..self.x.len())
            .map(|i| {
                let vs: Vec<f64> = self.series.iter().filter_map(|s| s.data[i]).collect();
                (!vs.is_empty()).then(|| vs.iter().sum())
            })
            .collect()
    }
}

impl Scatter {
    pub fn names(&self) -> Vec<String> {
        names(self.series.iter().map(|s| s.name.as_deref()))
    }
}

pub fn names<'a>(given: impl Iterator<Item = Option<&'a str>>) -> Vec<String> {
    given
        .enumerate()
        .map(|(i, n)| match n {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => format!("Series {}", i + 1),
        })
        .collect()
}

impl Matrix {
    /// How good a cell is within its column, from 0 (its worst) to 1 (its best); None for an unknown.
    /// A column whose values are all the same has nothing to tell apart, so all of it is 0.
    pub fn shade(&self, row: usize, column: usize) -> Option<f64> {
        let v = self.values[row][column]?;
        let known = self.values.iter().filter_map(|r| r[column]);
        let (lo, hi) = known.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
            (lo.min(v), hi.max(v))
        });
        if hi <= lo {
            return Some(0.0);
        }
        let up = (v - lo) / (hi - lo);
        Some(if self.columns[column].better == Some(Better::Low) {
            1.0 - up
        } else {
            up
        })
    }
}

impl Timeline {
    /// Lane names in the order they first come; "" for events in none.
    pub fn lanes(&self) -> Vec<String> {
        let mut seen: Vec<String> = vec![];
        for e in &self.events {
            let lane = e.lane.clone().unwrap_or_default();
            if !seen.contains(&lane) {
                seen.push(lane);
            }
        }
        seen
    }
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// "2024", "Mar 2024" or "15 Mar 2024".
pub fn date_text(date: &str) -> String {
    let n: Vec<i64> = date.split('-').filter_map(|p| p.parse().ok()).collect();
    match n.as_slice() {
        [y, m, d] if (1..=12).contains(m) => format!("{d} {} {y}", MONTHS[*m as usize - 1]),
        [y, m] if (1..=12).contains(m) => format!("{} {y}", MONTHS[*m as usize - 1]),
        _ => date.to_string(),
    }
}

/// An event's date, or its span: "Mar 2024 – Jun 2024".
pub fn when(e: &Event) -> String {
    match &e.end {
        Some(end) => format!("{} – {}", date_text(&e.date), date_text(end)),
        None => date_text(&e.date),
    }
}

/// Days since 1970-01-01 of a day counted on from 1 January, so month 13 and day 0 roll over as
/// the web's Date.UTC does.
fn day(y: i64, m: i64, d: i64) -> i64 {
    let (y, m) = (y + (m - 1).div_euclid(12), (m - 1).rem_euclid(12) + 1);
    // Howard Hinnant's days_from_civil.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468 + (d - 1)
}

/// The first and last day a timeline date covers, in days since 1970: 2024-03 is all of March.
/// None if it isn't YYYY, YYYY-MM or YYYY-MM-DD.
pub fn date_range(s: &str) -> Option<(i64, i64)> {
    let parts: Vec<&str> = s.split('-').collect();
    if !(1..=3).contains(&parts.len())
        || parts.iter().enumerate().any(|(i, p)| {
            p.len() != if i == 0 { 4 } else { 2 } || !p.bytes().all(|b| b.is_ascii_digit())
        })
    {
        return None;
    }
    let n: Vec<i64> = parts.iter().filter_map(|p| p.parse().ok()).collect();
    if n.len() > 1 && !(1..=12).contains(&n[1]) || n.len() > 2 && !(1..=31).contains(&n[2]) {
        return None;
    }
    Some(match n.as_slice() {
        [y, m, d] => (day(*y, *m, *d), day(*y, *m, *d)),
        [y, m] => (day(*y, *m, 1), day(*y, m + 1, 0)),
        [y] => (day(*y, 1, 1), day(*y, 12, 31)),
        _ => return None,
    })
}

/// The day a count of days since 1970 is: (year, month, day).
pub fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

pub fn month_name(m: i64) -> &'static str {
    MONTHS[(m - 1).clamp(0, 11) as usize]
}

/// 1,284 · 12.9K · 0.42 · $4.20 · 87% · 3.1 GiB. Compact from 1,000 up when `compact`.
pub fn format(v: f64, unit: Option<&str>, compact: bool) -> String {
    let a = v.abs();
    let money = unit.is_some_and(|u| u.chars().count() == 1 && "$€£¥₽₹".contains(u));
    let n = if compact && a >= 1000.0 {
        let (scaled, suffix) = if a >= 1e12 {
            (v / 1e12, "T")
        } else if a >= 1e9 {
            (v / 1e9, "B")
        } else if a >= 1e6 {
            (v / 1e6, "M")
        } else {
            (v / 1e3, "K")
        };
        number(scaled, 0, 1) + suffix
    } else if money && !compact && a < 100.0 {
        if v.fract() == 0.0 {
            number(v, 0, 0)
        } else {
            number(v, 2, 2)
        }
    } else {
        number(
            v,
            0,
            if a >= 100.0 {
                0
            } else if a >= 10.0 {
                1
            } else {
                2
            },
        )
    };
    match unit {
        None | Some("") => n,
        Some(u) if money => match n.strip_prefix('-') {
            Some(rest) => format!("-{u}{rest}"),
            None => format!("{u}{n}"),
        },
        Some("%") => format!("{n}%"),
        Some(u) => format!("{n} {u}"),
    }
}

/// en_US: grouped thousands, rounded half away from zero, at least `min` and at most `max` decimals.
fn number(v: f64, min: usize, max: usize) -> String {
    let scale = 10f64.powi(max as i32);
    let rounded = (v.abs() * scale).round() / scale;
    let mut text = format!("{rounded:.max$}");
    if let Some(dot) = text.find('.') {
        let keep = dot + 1 + min;
        while text.len() > keep && text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
    }
    let (whole, frac) = match text.find('.') {
        Some(dot) => (&text[..dot], &text[dot..]),
        None => (text.as_str(), ""),
    };
    let mut grouped = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let sign = if v < 0.0 && rounded != 0.0 { "-" } else { "" };
    format!("{sign}{grouped}{frac}")
}

/// Round tick values covering [lo, hi], about `count` of them.
pub fn nice_ticks(mut lo: f64, mut hi: f64, count: usize) -> Vec<f64> {
    if lo == hi {
        let pad = if lo == 0.0 { 1.0 } else { lo.abs() / 10.0 };
        lo -= pad;
        hi += pad;
    }
    let raw = (hi - lo) / count.max(1) as f64;
    let mag = 10f64.powf(raw.log10().floor());
    let step = [1.0, 2.0, 2.5, 5.0, 10.0]
        .into_iter()
        .find(|m| m * mag >= raw)
        .unwrap_or(10.0)
        * mag;
    let mut ticks = vec![];
    let mut t = (lo / step).floor() * step;
    while t < hi + step * 0.999 {
        // Float steps drift (0.30000000000000004); round to the step's precision.
        ticks.push(format!("{t:.12e}").parse().unwrap_or(t));
        if ticks.len() > 20 {
            break;
        }
        t += step;
    }
    ticks
}

/// A line, bar or scatter block with `"data": <attachment id>` in place of its values. The brain
/// reads the file and answers GET /attachments/:id/chart with them; merged into the block's own keys,
/// they make a ChartSpec that goes through the same checks as one typed in.
#[derive(Debug, Clone, PartialEq)]
pub struct ChartFile {
    pub id: i64,
    pub kind: String,
    /// The block's keys less `data`.
    keys: Map<String, Value>,
}

impl ChartFile {
    /// The file chart in a chart block, or None if it isn't one.
    pub fn parse(source: &str) -> Option<ChartFile> {
        let Value::Object(mut keys) = serde_json::from_str(source).ok()? else {
            return None;
        };
        let id = keys.remove("data")?.as_i64().filter(|id| *id > 0)?;
        let kind = keys.get("type")?.as_str()?.to_string();
        if !["line", "bar", "scatter"].contains(&kind.as_str()) {
            return None;
        }
        let file = ChartFile { id, kind, keys };
        if file.values().iter().any(|k| file.keys.contains_key(*k)) {
            return None;
        }
        // The rest of the block (title, unit, names) checks out the same way a typed one does, so it's
        // tried with a single made-up value.
        let stand = if file.kind == "scatter" {
            json!({"series": [{"points": [{"x": 0, "y": 0}]}]})
        } else {
            json!({"x": [0], "series": [{"data": [0]}]})
        };
        file.spec(&stand).map(|_| file)
    }

    fn values(&self) -> &'static [&'static str] {
        if self.kind == "scatter" {
            &["series"]
        } else {
            &["x", "series"]
        }
    }

    /// Where the brain answers with the values.
    pub fn path(&self) -> String {
        format!("/attachments/{}/chart?type={}", self.id, self.kind)
    }

    /// The chart with the brain's values in it, or None if they don't check out. Only the values are
    /// taken from the answer; the title and units stay the block's.
    pub fn spec(&self, answer: &Value) -> Option<ChartSpec> {
        let mut block = self.keys.clone();
        for k in self.values() {
            block.insert(k.to_string(), answer.get(*k)?.clone());
        }
        ChartSpec::from_value(Value::Object(block))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chart_checks_out_as_the_shared_spec_has_it() {
        // Number labels become text.
        let s = ChartSpec::parse(r#"{"type":"line","x":[2024,1.5],"series":[{"data":[1,null]}]}"#);
        let Some(ChartSpec {
            kind: Kind::Line(s),
            ..
        }) = s
        else {
            panic!("not a line chart")
        };
        assert_eq!(s.x, ["2024", "1.5"]);
        for bad in [
            // A value too few.
            r#"{"type":"bar","x":["a","b"],"series":[{"data":[1]}]}"#,
            // Values and a file.
            r#"{"type":"bar","data":3,"x":["a"],"series":[{"data":[1]}]}"#,
            // An optional field sent as null.
            r#"{"type":"bar","x":["a"],"series":[{"name":null,"data":[1]}]}"#,
            r#"{"type":"range","rows":[{"label":"a","low":1,"high":2,"mark":3}]}"#,
            r#"{"type":"timeline","events":[{"date":"2024-13","label":"a"}]}"#,
            r#"{"type":"timeline","events":[{"date":"2024-03","end":"2024-02","label":"a"}]}"#,
        ] {
            assert_eq!(ChartSpec::parse(bad), None, "{bad}");
        }
        assert_eq!(date_range("2024-02").map(|(a, b)| b - a + 1), Some(29));

        let m = r#"{"type":"matrix","rows":["a","b","c"],"columns":[{"name":"Price","better":"low"}],
            "values":[[1],[2],[null]]}"#;
        let Some(ChartSpec {
            kind: Kind::Matrix(m),
            ..
        }) = ChartSpec::parse(m)
        else {
            panic!("not a matrix")
        };
        assert_eq!(
            (0..3).map(|r| m.shade(r, 0)).collect::<Vec<_>>(),
            [Some(1.0), Some(0.0), None]
        );

        // A file chart keeps its own title and unit, and takes only the values.
        let f = ChartFile::parse(r#"{"type":"line","title":"CPU","unit":"%","data":7}"#).unwrap();
        assert_eq!(f.path(), "/attachments/7/chart?type=line");
        let spec = f
            .spec(&json!({"title": "x", "x": ["a"], "series": [{"data": [3]}]}))
            .unwrap();
        assert_eq!(spec.title.as_deref(), Some("CPU"));
    }
}
