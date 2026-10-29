// The spend page's charts, as Spend.swift on iOS and Spend.tsx on the web.
use super::chart::{ChartSpec, Kind, Line, MAX_ROWS, Series, month_name};
use super::format;
use super::models::{SpendByBot, SpendByModel, SpendByPurpose, SpendDay, SpendHour};

/// Each chart's numbers; one a brain doesn't have yet is empty.
#[derive(Debug, Clone, Default)]
pub struct SpendDetail {
    pub hourly: Vec<SpendHour>,
    pub daily: Vec<SpendDay>,
    pub by_model: Vec<SpendByModel>,
    pub by_bot: Vec<SpendByBot>,
    pub by_purpose: Vec<SpendByPurpose>,
}

const PURPOSES: [(&str, &str); 13] = [
    ("thread", "Chat"),
    ("task", "Tasks"),
    ("heartbeat", "Heartbeat"),
    ("summary", "Summaries"),
    ("review", "Reviewing changes"),
    ("screening", "Screening"),
    ("expert", "Asking Opus"),
    ("research", "Research"),
    ("check", "Checks"),
    ("teach", "Teaching"),
    ("tidy", "Memory tidy-ups"),
    ("skill-fix", "Skill fixes"),
    ("boxes", "Boxes"),
];

/// "14:00" in local time for each hour.
pub fn hourly(hours: &[SpendHour]) -> Option<ChartSpec> {
    let x =
        hours.iter().map(|h| format::date(&h.hour).map_or(h.hour.clone(), |d| format!("{:02}:00", d.hour()))).collect();
    bars(x, hours.iter().map(|h| h.usd).collect())
}

pub fn daily(days: &[SpendDay]) -> Option<ChartSpec> {
    bars(days.iter().map(|d| day(&d.date)).collect(), days.iter().map(|d| d.usd).collect())
}

pub fn by_model(rows: &[SpendByModel]) -> Option<ChartSpec> {
    ranking(rows.iter().map(|r| (format::model_name(&r.model), r.usd)))
}

pub fn by_bot(rows: &[SpendByBot], name: impl Fn(&str) -> Option<String>) -> Option<ChartSpec> {
    ranking(rows.iter().map(|r| (name(&r.bot_id).unwrap_or(r.bot_id.clone()), r.usd)))
}

pub fn by_purpose(rows: &[SpendByPurpose]) -> Option<ChartSpec> {
    ranking(rows.iter().map(|r| {
        let name = PURPOSES
            .iter()
            .find(|(k, _)| *k == r.purpose)
            .map_or_else(|| capitalised(&r.purpose), |(_, n)| n.to_string());
        (name, r.cost_usd)
    }))
}

fn capitalised(s: &str) -> String {
    let mut c = s.chars();
    c.next().map_or(String::new(), |f| f.to_uppercase().chain(c).collect())
}

/// "15 Oct" for "2026-10-15".
fn day(date: &str) -> String {
    let parts: Vec<i64> = date.split('-').filter_map(|p| p.parse().ok()).collect();
    match parts.as_slice() {
        [_, m, d] if (1..=12).contains(m) => format!("{d} {}", month_name(*m)),
        _ => date.into(),
    }
}

fn spend(x: Vec<String>, usd: Vec<f64>, horizontal: bool) -> ChartSpec {
    ChartSpec {
        title: None,
        kind: Kind::Bar(Series {
            unit: Some("$".into()),
            horizontal,
            x,
            series: vec![Line { name: Some("Spend".into()), data: usd.into_iter().map(Some).collect() }],
            ..Series::default()
        }),
    }
}

fn bars(x: Vec<String>, usd: Vec<f64>) -> Option<ChartSpec> {
    usd.iter().any(|v| *v > 0.0).then(|| spend(x, usd, false))
}

/// Biggest first; ones that cost nothing left out.
fn ranking(rows: impl Iterator<Item = (String, f64)>) -> Option<ChartSpec> {
    let mut shown: Vec<(String, f64)> = rows.filter(|r| r.1 > 0.0).collect();
    shown.sort_by(|a, b| b.1.total_cmp(&a.1));
    shown.truncate(MAX_ROWS);
    let (x, usd) = shown.into_iter().unzip::<_, _, Vec<_>, Vec<_>>();
    (!x.is_empty()).then(|| spend(x, usd, true))
}
