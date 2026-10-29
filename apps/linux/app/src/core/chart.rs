// A ```chart block's JSON (packages/shared/src/chart.ts, Chart.swift on iOS). One that doesn't check out
// stays a code block.
use reqwest::Url;
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};

/// Past three series the colours stop telling apart for colour-blind readers.
pub const MAX_SERIES: usize = 3;
pub const MAX_POINTS: usize = 500;
/// Horizontal bars take a row each, so fewer of them.
pub const MAX_ROWS: usize = 40;
pub const MAX_COLUMNS: usize = 8;
pub const MAX_EVENTS: usize = 60;
pub const MAX_LANES: usize = 8;
pub const MAX_LISTINGS: usize = 30;
pub const MAX_REFS: usize = 3;
/// A year, with a week to spare at each end.
pub const MAX_DAYS: usize = 371;
pub const MAX_TILES: usize = 60;
pub const MAX_COMPARED: usize = 4;
pub const MAX_OFFERS: usize = 40;
pub const MAX_PHOTOS: usize = 20;

/// Where listing photos may come from: the marketplaces' image servers, as Scout keeps them.
const PHOTO_HOSTS: [&str; 3] = ["olxcdn.com", "allegroimg.com", "vinted.net"];

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
    Listings(Listings),
    Meter(Meter),
    Calendar(Calendar),
    Treemap(Treemap),
    Compare(Compare),
    Offers(Offers),
    Gallery(Gallery),
}

/// Line and bar: one value per x for each series.
#[derive(Deserialize, Debug, Clone, PartialEq, Default)]
pub struct Series {
    /// "%", "GiB", "ms", or a currency symbol ("$", "€"), which goes in front.
    #[serde(default, deserialize_with = "present")]
    pub unit: Option<String>,
    /// Bars: the series stack into one bar per x, as parts of its total.
    #[serde(default)]
    pub stacked: bool,
    /// Bars: one row per x, for rankings and long names.
    #[serde(default)]
    pub horizontal: bool,
    #[serde(default)]
    pub refs: Vec<Ref>,
    #[serde(deserialize_with = "labels")]
    pub x: Vec<String>,
    pub series: Vec<Line>,
}

/// A line across the values: a limit, a typical price.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Ref {
    pub value: f64,
    pub label: String,
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

/// Things for sale, as a row of cards to scroll.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Listings {
    /// The prices' currency: "zł", "€".
    #[serde(default, deserialize_with = "present")]
    pub unit: Option<String>,
    pub items: Vec<Listing>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Listing {
    pub title: String,
    pub url: String,
    #[serde(default, deserialize_with = "present")]
    pub price: Option<f64>,
    /// Only listing_photo's are shown, through the brain.
    #[serde(default, deserialize_with = "present")]
    pub photo: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub site: Option<String>,
    /// A few words the title doesn't say: "Like new, Kraków".
    #[serde(default, deserialize_with = "present")]
    pub note: Option<String>,
}

/// How full things are: disks, datastores, a spending limit.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Meter {
    #[serde(default, deserialize_with = "present")]
    pub unit: Option<String>,
    pub rows: Vec<MeterRow>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct MeterRow {
    pub label: String,
    pub value: f64,
    pub max: f64,
    /// From here on the bar shows as a warning.
    #[serde(default, deserialize_with = "present")]
    pub warn: Option<f64>,
}

/// A value a day, as a grid of weeks.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Calendar {
    #[serde(default, deserialize_with = "present")]
    pub unit: Option<String>,
    pub days: Vec<Day>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Day {
    /// YYYY-MM-DD.
    pub date: String,
    pub value: f64,
}

/// Parts of a whole as boxes sized by value.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Treemap {
    #[serde(default, deserialize_with = "present")]
    pub unit: Option<String>,
    pub items: Vec<Item>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Item {
    pub label: String,
    pub value: f64,
}

/// Two to four things side by side, a row per property, in words.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Compare {
    pub columns: Vec<String>,
    pub rows: Vec<CompareRow>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct CompareRow {
    pub label: String,
    /// One per column; None where it isn't known.
    pub values: Vec<Option<String>>,
    /// The column that's best on this row, from 0.
    #[serde(default, deserialize_with = "index")]
    pub best: Option<usize>,
}

/// A haggle's offers in turn, yours and theirs, under your limit.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Offers {
    #[serde(default, deserialize_with = "present")]
    pub unit: Option<String>,
    /// Who "them" is: "Seller", "Buyer".
    #[serde(default, deserialize_with = "present")]
    pub them: Option<String>,
    /// The most you'd pay, or the least you'd take.
    #[serde(default, deserialize_with = "present")]
    pub limit: Option<f64>,
    pub offers: Vec<Offer>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Offer {
    pub by: Side,
    pub price: f64,
    #[serde(default, deserialize_with = "present")]
    pub note: Option<String>,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    You,
    Them,
}

/// One listing's photos.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Gallery {
    /// The listing.
    #[serde(default, deserialize_with = "present")]
    pub url: Option<String>,
    pub photos: Vec<String>,
}

/// A field the spec makes optional may be left out, but not sent as null.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// A whole number from 0, written as JSON writes numbers (1 or 1.0).
fn index<'de, D: Deserializer<'de>>(d: D) -> Result<Option<usize>, D::Error> {
    let n = f64::deserialize(d)?;
    if n < 0.0 || n.fract() != 0.0 || n > u32::MAX as f64 {
        return Err(serde::de::Error::custom("not a column"));
    }
    Ok(Some(n as usize))
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
fn len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn fits(s: Option<&str>, max: usize) -> bool {
    s.is_none_or(|s| len(s) <= max)
}

fn is_label(s: &str) -> bool {
    (1..=60).contains(&len(s))
}

fn link(s: &str) -> bool {
    len(s) <= 2000 && web_address(s, false)
}

fn photo(s: &str) -> bool {
    len(s) <= 2000 && web_address(s, true)
}

/// An http or https address written out in full; with `https`, only https.
pub fn web_address(s: &str, https: bool) -> bool {
    let lower = s.get(..8).unwrap_or(s).to_ascii_lowercase();
    if !lower.starts_with("https://") && !lower.starts_with("http://") {
        return false;
    }
    Url::parse(s).is_ok_and(|u| {
        u.host_str().is_some_and(|h| !h.is_empty()) && (u.scheme() == "https" || (!https && u.scheme() == "http"))
    })
}

/// Whether the brain fetches this photo for a listings block. Anything else would let a reply make it ask
/// any server for an address of its choosing.
pub fn listing_photo(s: &str) -> bool {
    if !web_address(s, true) {
        return false;
    }
    let Ok(u) = Url::parse(s) else { return false };
    if u.port().is_some() || !u.username().is_empty() || u.password().is_some() {
        return false;
    }
    let host = u.host_str().unwrap_or_default().to_lowercase();
    PHOTO_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// The brain's path for a listing photo, or None for one it won't fetch.
pub fn photo_path(url: &str) -> Option<String> {
    listing_photo(url).then(|| format!("/listing-photo?url={}", encode(url)))
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

impl ChartSpec {
    pub fn parse(source: &str) -> Option<ChartSpec> {
        Self::from_value(serde_json::from_str(source).ok()?)
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
                    && s.x.iter().all(|x| len(x) <= 60)
                    && (1..=MAX_SERIES).contains(&s.series.len())
                    && s.series.iter().all(|l| fits(l.name.as_deref(), 60) && l.data.len() == s.x.len())
                    && s.series.iter().any(|l| l.data.iter().any(Option::is_some))
                    && !(bar && s.horizontal && s.x.len() > MAX_ROWS)
                    && s.refs.len() <= MAX_REFS
                    && s.refs.iter().all(|r| (1..=40).contains(&len(&r.label)))
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
                            && se.points.iter().all(|p| p.label.as_deref().is_none_or(is_label))
                    })
                    && s.series.iter().map(|se| se.points.len()).sum::<usize>() <= MAX_POINTS
            }
            Kind::Range(r) => {
                fits(r.unit.as_deref(), 12)
                    && fits(r.mark_name.as_deref(), 60)
                    && (1..=MAX_ROWS).contains(&r.rows.len())
                    && r.rows.iter().all(|row| {
                        is_label(&row.label)
                            && row.low <= row.high
                            && row.mark.is_none_or(|m| m >= row.low && m <= row.high)
                    })
            }
            Kind::Matrix(m) => {
                (1..=MAX_ROWS).contains(&m.rows.len())
                    && m.rows.iter().all(|r| is_label(r))
                    && (1..=MAX_COLUMNS).contains(&m.columns.len())
                    && m.columns.iter().all(|c| is_label(&c.name) && fits(c.unit.as_deref(), 12))
                    && m.values.len() == m.rows.len()
                    && m.values.iter().all(|r| r.len() == m.columns.len())
            }
            Kind::Timeline(t) => {
                (1..=MAX_EVENTS).contains(&t.events.len())
                    && t.events.iter().all(|e| {
                        let Some((start, _)) = date_range(&e.date) else { return false };
                        is_label(&e.label)
                            && fits(e.lane.as_deref(), 40)
                            && e.end.as_deref().is_none_or(|end| date_range(end).is_some_and(|(_, last)| start <= last))
                    })
                    && t.lanes().len() <= MAX_LANES
            }
            Kind::Listings(l) => {
                fits(l.unit.as_deref(), 12)
                    && (1..=MAX_LISTINGS).contains(&l.items.len())
                    && l.items.iter().all(|it| {
                        (1..=200).contains(&len(&it.title))
                            && link(&it.url)
                            && it.photo.as_deref().is_none_or(photo)
                            && fits(it.site.as_deref(), 40)
                            && fits(it.note.as_deref(), 80)
                    })
            }
            Kind::Meter(m) => {
                fits(m.unit.as_deref(), 12)
                    && (1..=MAX_ROWS).contains(&m.rows.len())
                    && m.rows.iter().all(|r| {
                        is_label(&r.label)
                            && r.value >= 0.0
                            && r.max > 0.0
                            && r.warn.is_none_or(|w| w > 0.0 && w <= r.max)
                    })
            }
            Kind::Calendar(c) => {
                let dates: Vec<&str> = c.days.iter().map(|d| d.date.as_str()).collect();
                let mut unique = dates.clone();
                unique.sort_unstable();
                unique.dedup();
                fits(c.unit.as_deref(), 12)
                    && (1..=MAX_DAYS).contains(&dates.len())
                    && dates.iter().all(|d| d.split('-').count() == 3 && date_range(d).is_some())
                    && unique.len() == dates.len()
                    && calendar_weeks(&dates).len() <= 54
            }
            Kind::Treemap(t) => {
                fits(t.unit.as_deref(), 12)
                    && (1..=MAX_TILES).contains(&t.items.len())
                    && t.items.iter().all(|it| is_label(&it.label) && it.value > 0.0)
            }
            Kind::Compare(c) => {
                (2..=MAX_COMPARED).contains(&c.columns.len())
                    && c.columns.iter().all(|s| is_label(s))
                    && (1..=MAX_ROWS).contains(&c.rows.len())
                    && c.rows.iter().all(|r| {
                        is_label(&r.label)
                            && r.values.len() == c.columns.len()
                            && r.values.iter().all(|v| fits(v.as_deref(), 80))
                            && r.best.is_none_or(|b| b < c.columns.len())
                    })
            }
            Kind::Offers(o) => {
                fits(o.unit.as_deref(), 12)
                    && o.them.as_deref().is_none_or(|t| (1..=40).contains(&len(t)))
                    && (1..=MAX_OFFERS).contains(&o.offers.len())
                    && o.offers.iter().all(|f| f.price >= 0.0 && fits(f.note.as_deref(), 60))
            }
            Kind::Gallery(g) => {
                g.url.as_deref().is_none_or(link)
                    && (1..=MAX_PHOTOS).contains(&g.photos.len())
                    && g.photos.iter().all(|p| photo(p))
            }
        }
    }
}

/// Series names, with "Series 2" for one Hatbot left unnamed.
pub fn names<'a>(given: impl Iterator<Item = Option<&'a str>>) -> Vec<String> {
    given
        .enumerate()
        .map(|(i, n)| match n {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => format!("Series {}", i + 1),
        })
        .collect()
}

impl Series {
    pub fn names(&self) -> Vec<String> {
        names(self.series.iter().map(|s| s.name.as_deref()))
    }

    /// Whether the bars stack: asked for, on a bar chart, with more than one series to stack.
    pub fn is_stacked(&self, bar: bool) -> bool {
        bar && self.stacked && self.series.len() > 1
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

impl Matrix {
    /// How good a cell is within its column, from 0 (its worst) to 1 (its best); None where it isn't known
    /// or its column has nothing to tell apart.
    pub fn shade(&self, row: usize, column: usize) -> Option<f64> {
        let v = self.values.get(row)?.get(column).copied().flatten()?;
        let (lo, hi) = self
            .values
            .iter()
            .filter_map(|r| r[column])
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| (lo.min(v), hi.max(v)));
        if hi <= lo {
            return None;
        }
        let up = (v - lo) / (hi - lo);
        Some(if self.columns[column].better == Some(Better::Low) { 1.0 - up } else { up })
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

impl Listing {
    /// The site's name, or the address's host without www., and the note.
    pub fn place(&self) -> String {
        let site = match self.site.as_deref() {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => Url::parse(&self.url)
                .ok()
                .and_then(|u| u.host_str().map(|h| h.strip_prefix("www.").unwrap_or(h).to_string()))
                .unwrap_or_default(),
        };
        [site.as_str(), self.note.as_deref().unwrap_or_default()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
    }
}

impl MeterRow {
    pub fn warning(&self) -> bool {
        self.value > self.max || self.warn.is_some_and(|w| self.value >= w)
    }
}

impl CompareRow {
    /// Two or more known values, all the same: nothing on this row tells them apart.
    pub fn alike(&self) -> bool {
        let mut known = self.values.iter().flatten();
        let Some(first) = known.next() else { return false };
        let mut count = 1;
        for v in known {
            if v != first {
                return false;
            }
            count += 1;
        }
        count > 1
    }
}

impl Offers {
    pub fn them_name(&self) -> &str {
        self.them.as_deref().unwrap_or("Them")
    }
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

pub fn month_name(m: i64) -> &'static str {
    MONTHS[(m - 1).clamp(0, 11) as usize]
}

/// "2024", "Mar 2024" or "Mar 15, 2024".
pub fn date_text(date: &str) -> String {
    let n: Vec<i64> = date.split('-').filter_map(|p| p.parse().ok()).collect();
    match n.as_slice() {
        [y, m, d] if (1..=12).contains(m) => format!("{} {d}, {y}", month_name(*m)),
        [y, m] if (1..=12).contains(m) => format!("{} {y}", month_name(*m)),
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

/// Days since 1970-01-01 of a day counted on from 1 January, so month 13 and day 0 roll over as the
/// web's Date.UTC does.
pub fn day_number(y: i64, m: i64, d: i64) -> i64 {
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

/// Monday is 0.
pub fn weekday(days: i64) -> i64 {
    (days + 3).rem_euclid(7)
}

/// The first and last day a timeline date covers, in days since 1970: 2024-03 is all of March. None if it
/// isn't YYYY, YYYY-MM or YYYY-MM-DD.
pub fn date_range(s: &str) -> Option<(i64, i64)> {
    let parts: Vec<&str> = s.split('-').collect();
    if !(1..=3).contains(&parts.len())
        || parts
            .iter()
            .enumerate()
            .any(|(i, p)| p.len() != if i == 0 { 4 } else { 2 } || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let n: Vec<i64> = parts.iter().filter_map(|p| p.parse().ok()).collect();
    if n.len() > 1 && !(1..=12).contains(&n[1]) || n.len() > 2 && !(1..=31).contains(&n[2]) {
        return None;
    }
    Some(match n.as_slice() {
        [y, m, d] => (day_number(*y, *m, *d), day_number(*y, *m, *d)),
        [y, m] => (day_number(*y, *m, 1), day_number(*y, m + 1, 0)),
        [y] => (day_number(*y, 1, 1), day_number(*y, 12, 31)),
        _ => return None,
    })
}

/// A calendar's weeks, Monday first, from the week of the first day to the week of the last: each seven
/// days, in days since 1970.
pub fn calendar_weeks(dates: &[&str]) -> Vec<[i64; 7]> {
    let days: Vec<i64> = dates.iter().filter_map(|d| date_range(d).map(|r| r.0)).collect();
    let (Some(lo), Some(hi)) = (days.iter().min(), days.iter().max()) else { return vec![] };
    let mut week = lo - weekday(*lo);
    let mut weeks = vec![];
    while week <= *hi {
        weeks.push(std::array::from_fn(|i| week + i as i64));
        week += 7;
    }
    weeks
}

/// One of `treemap`'s boxes; `i` is its index in the values.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tile {
    pub i: usize,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Squarified treemap (Bruls, Huizing and van Wijk): boxes for `values` in a w×h rectangle, as close to
/// square as it gets, largest first. Step for step packages/shared's, so both draw the same boxes.
pub fn treemap(values: &[f64], w: f64, h: f64) -> Vec<Tile> {
    let mut order: Vec<(f64, usize)> = values.iter().copied().zip(0..).collect();
    // Stable, so ties keep their order as JavaScript's sort does.
    order.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let total: f64 = order.iter().map(|o| o.0).sum();
    if total == 0.0 || total.is_nan() || w <= 0.0 || h <= 0.0 {
        return vec![];
    }
    let scale = w * h / total;
    let mut tiles = vec![];
    let (mut x, mut y, mut rw, mut rh) = (0.0, 0.0, w, h);
    let worst = |row: &[f64], side: f64| {
        let sum: f64 = row.iter().sum();
        let max = row.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let min = row.iter().copied().fold(f64::INFINITY, f64::min);
        f64::max(side * side * max / (sum * sum), sum * sum / (side * side * min))
    };
    let mut row: Vec<(f64, usize)> = vec![];
    let mut lay = |row: &mut Vec<(f64, usize)>, x: &mut f64, y: &mut f64, rw: &mut f64, rh: &mut f64| {
        let areas: Vec<f64> = row.iter().map(|o| o.0 * scale).collect();
        let sum: f64 = areas.iter().sum();
        if *rw >= *rh {
            let cw = sum / *rh;
            let mut cy = *y;
            for (k, o) in row.iter().enumerate() {
                let th = areas[k] / cw;
                tiles.push(Tile { i: o.1, x: *x, y: cy, w: cw, h: th });
                cy += th;
            }
            *x += cw;
            *rw -= cw;
        } else {
            let ch = sum / *rw;
            let mut cx = *x;
            for (k, o) in row.iter().enumerate() {
                let tw = areas[k] / ch;
                tiles.push(Tile { i: o.1, x: cx, y: *y, w: tw, h: ch });
                cx += tw;
            }
            *y += ch;
            *rh -= ch;
        }
        row.clear();
    };
    for o in order {
        let side = rw.min(rh);
        let now: Vec<f64> = row.iter().map(|r| r.0 * scale).collect();
        if !row.is_empty() {
            let mut with = now.clone();
            with.push(o.0 * scale);
            if worst(&with, side) > worst(&now, side) {
                lay(&mut row, &mut x, &mut y, &mut rw, &mut rh);
            }
        }
        row.push(o);
    }
    if !row.is_empty() {
        lay(&mut row, &mut x, &mut y, &mut rw, &mut rh);
    }
    tiles
}

/// 1,284 · 12.9K · 0.42 · $4.20 · 87% · 3.1 GiB. Compact from 1,000 up when `compact`.
pub fn format(v: f64, unit: Option<&str>, compact: bool) -> String {
    let a = v.abs();
    let money = unit.is_some_and(|u| u.chars().count() == 1 && "$€£¥₽₹".contains(u));
    let n = if compact && a >= 1000.0 {
        // The tier is picked after rounding, as Intl does: 999,950 is 1M, not 1,000K.
        let tiers = [(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")];
        let mut k = tiers.iter().position(|(t, _)| a >= *t).unwrap_or(3);
        if k > 0 && number(a / tiers[k].0, 0, 1) == "1,000" {
            k -= 1;
        }
        number(v / tiers[k].0, 0, 1) + tiers[k].1
    } else if money && !compact && a < 100.0 {
        if v.fract() == 0.0 { number(v, 0, 0) } else { number(v, 2, 2) }
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

/// en-US: grouped thousands, half away from zero on the exact value, `min` to `max` decimals.
fn number(v: f64, min: usize, max: usize) -> String {
    let exact = format!("{:.40}", v.abs());
    let (whole, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits: Vec<u8> = whole.bytes().chain(frac.bytes().take(max)).map(|b| b - b'0').collect();
    if frac.as_bytes().get(max).is_some_and(|d| *d >= b'5') {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, 1);
                break;
            }
            i -= 1;
            if digits[i] == 9 {
                digits[i] = 0;
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let split = digits.len() - max;
    let mut frac: Vec<u8> = digits[split..].to_vec();
    while frac.len() > min && frac.last() == Some(&0) {
        frac.pop();
    }
    let whole = &digits[..split];
    let mut out = String::new();
    if v < 0.0 && (whole.iter().any(|d| *d != 0) || frac.iter().any(|d| *d != 0)) {
        out.push('-');
    }
    for (i, d) in whole.iter().enumerate() {
        if i > 0 && (whole.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push((b'0' + d) as char);
    }
    if !frac.is_empty() {
        out.push('.');
        out.extend(frac.iter().map(|d| (b'0' + d) as char));
    }
    out
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
    let step = [1.0, 2.0, 2.5, 5.0, 10.0].into_iter().find(|m| m * mag >= raw).unwrap_or(10.0) * mag;
    let mut ticks = vec![];
    let mut t = (lo / step).floor() * step;
    while t < hi + step * 0.999 {
        // Float steps drift (0.30000000000000004); round to twelve digits, as toPrecision(12).
        ticks.push(format!("{t:.11e}").parse().unwrap_or(t));
        if ticks.len() > 20 {
            break;
        }
        t += step;
    }
    ticks
}

/// A line, bar or scatter block with `"data": <attachment id>` in place of its values. The brain reads the
/// file and answers GET /attachments/{id}/chart?type= with them; merged into the block's own keys, they
/// make a ChartSpec that goes through the same checks as one typed in.
#[derive(Debug, Clone, PartialEq)]
pub struct ChartFile {
    pub id: u64,
    /// "line", "bar" or "scatter".
    pub kind: String,
    pub title: Option<String>,
    /// The block's keys less `data`.
    keys: Map<String, Value>,
}

impl ChartFile {
    pub fn parse(source: &str) -> Option<ChartFile> {
        let Value::Object(mut keys) = serde_json::from_str(source).ok()? else { return None };
        let id = keys.remove("data")?.as_f64().filter(|n| *n >= 1.0 && n.fract() == 0.0 && *n < 9e15)? as u64;
        let kind = keys.get("type")?.as_str()?.to_string();
        if !["line", "bar", "scatter"].contains(&kind.as_str()) {
            return None;
        }
        let title = keys.get("title").and_then(Value::as_str).map(str::to_string);
        let file = ChartFile { id, kind, title, keys };
        if file.values().iter().any(|k| file.keys.contains_key(*k)) {
            return None;
        }
        // The rest of the block (title, unit, names) checks out the same way a typed one does, so it's tried
        // with a single made-up value.
        let stand = if file.kind == "scatter" {
            json!({"series": [{"points": [{"x": 0, "y": 0}]}]})
        } else {
            json!({"x": [0], "series": [{"data": [0]}]})
        };
        file.merge(&stand).map(|_| file)
    }

    fn values(&self) -> &'static [&'static str] {
        if self.kind == "scatter" { &["series"] } else { &["x", "series"] }
    }

    /// Where the brain answers with the file's values.
    pub fn path(&self) -> String {
        format!("/attachments/{}/chart?type={}", self.id, self.kind)
    }

    /// The chart with the brain's answer in it, or None if its values don't check out. Only the values are
    /// taken from the answer; the title and units stay the block's.
    pub fn spec(&self, merging: &[u8]) -> Option<ChartSpec> {
        self.merge(&serde_json::from_slice(merging).ok()?)
    }

    fn merge(&self, answer: &Value) -> Option<ChartSpec> {
        let mut block = self.keys.clone();
        for k in self.values() {
            block.insert(k.to_string(), answer.get(*k)?.clone());
        }
        ChartSpec::from_value(Value::Object(block))
    }
}

/// A piece of a message: Markdown, or a chart block cut out of it.
#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Markdown(String),
    Chart(Box<ChartSpec>),
    File(ChartFile),
    /// A chart block still streaming in.
    Pending,
}

/// The fence a line opens or closes with: its character and length, and what follows it.
fn fence(line: &str) -> Option<(u8, usize, &str)> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let indent = line.bytes().take_while(|b| *b == b' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let c = *rest.as_bytes().first()?;
    if c != b'`' && c != b'~' {
        return None;
    }
    let n = rest.bytes().take_while(|b| *b == c).count();
    (n >= 3).then(|| (c, n, &rest[n..]))
}

/// Cuts a message's Markdown at its ```chart blocks (fences as apps/web/src/md-blocks.ts has them). A block
/// that doesn't draw stays in the Markdown as code; one still open at the end of a streaming message is
/// Pending.
pub fn split(text: &str, streaming: bool) -> Vec<Part> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut parts: Vec<Part> = vec![];
    let mut md: Vec<&str> = vec![];
    let push_md = |parts: &mut Vec<Part>, md: &mut Vec<&str>| {
        let joined = md.join("\n");
        md.clear();
        if joined.trim().is_empty() {
            return;
        }
        if let Some(Part::Markdown(last)) = parts.last_mut() {
            last.push('\n');
            last.push_str(&joined);
        } else {
            parts.push(Part::Markdown(joined));
        }
    };
    let mut i = 0;
    while i < lines.len() {
        let Some((c, n, info)) = fence(lines[i]) else {
            md.push(lines[i]);
            i += 1;
            continue;
        };
        let close = (i + 1..lines.len())
            .find(|&k| fence(lines[k]).is_some_and(|(c2, n2, after)| c2 == c && n2 >= n && after.trim().is_empty()));
        let end = close.unwrap_or(lines.len());
        let block = &lines[i..close.map_or(end, |k| k + 1)];
        if info.trim() == "chart" {
            let source = lines[i + 1..end].join("\n");
            let part = if let Some(spec) = ChartSpec::parse(&source) {
                Some(Part::Chart(Box::new(spec)))
            } else if let Some(file) = ChartFile::parse(&source) {
                Some(Part::File(file))
            } else if close.is_none() && streaming {
                Some(Part::Pending)
            } else {
                None
            };
            if let Some(part) = part {
                push_md(&mut parts, &mut md);
                parts.push(part);
                i = close.map_or(lines.len(), |k| k + 1);
                continue;
            }
        }
        md.extend_from_slice(block);
        i = close.map_or(lines.len(), |k| k + 1);
    }
    push_md(&mut parts, &mut md);
    parts
}
