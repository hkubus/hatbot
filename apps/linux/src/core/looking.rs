// As Looking.swift, Format.swift and LookingViews.swift on iOS.
use serde_json::{Map, Value, json};

use super::format;
use super::models::{Approval, ApprovalStatus, HeartbeatRun, WatchCondition, Watcher};

pub const MODELS: [&str; 2] = ["claude-haiku-5-5", "claude-opus-5-5"];
pub const EFFORTS: [(&str, &str); 5] = [
    ("low", "Low"),
    ("medium", "Medium"),
    ("high", "High"),
    ("xhigh", "Extra high"),
    ("max", "Max"),
];
pub const HEARTBEAT_EVERY: [i64; 7] = [5, 10, 15, 30, 60, 120, 240];

/// Known values with their names, and the current one if it isn't among them, so saving something
/// else doesn't quietly change it.
pub fn choices(known: &[(String, String)], current: &str) -> Vec<(String, String)> {
    let mut out = known.to_vec();
    if !current.is_empty() && !out.iter().any(|(v, _)| v == current) {
        out.push((current.into(), current.into()));
    }
    out
}

pub fn model_choices(current: &str) -> Vec<(String, String)> {
    let known: Vec<_> = MODELS
        .iter()
        .map(|m| (m.to_string(), format::model_name(m)))
        .collect();
    choices(&known, current)
}

pub fn effort_choices(current: &str) -> Vec<(String, String)> {
    let known: Vec<_> = EFFORTS
        .iter()
        .map(|(v, n)| (v.to_string(), n.to_string()))
        .collect();
    choices(&known, current)
}

/// The heartbeat's intervals, with the current one in its place.
pub fn every_choices(current: i64) -> Vec<i64> {
    let mut out = HEARTBEAT_EVERY.to_vec();
    if !out.contains(&current) {
        out.push(current);
        out.sort();
    }
    out
}

/// "Every hour", "Every 15 minutes", "Every 2 days".
pub fn every(minutes: i64) -> String {
    let (n, word) = if minutes % 1440 == 0 {
        (minutes / 1440, "day")
    } else if minutes % 60 == 0 {
        (minutes / 60, "hour")
    } else {
        (minutes, "minute")
    };
    if n == 1 {
        format!("Every {word}")
    } else {
        format!("Every {n} {word}s")
    }
}

/// 1000 → "1000", 12.5 → "12.5".
pub fn number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        n.to_string()
    }
}

pub fn condition(c: &WatchCondition) -> String {
    let text = c.text.as_deref().unwrap_or("");
    let value = number(c.value.unwrap_or(0.0));
    match c.when.as_str() {
        "contains" => format!("Contains “{text}”"),
        "missing" => format!("Doesn't contain “{text}”"),
        "below" => format!("Below {value}"),
        "above" => format!("Above {value}"),
        _ => "Changes".into(),
    }
}

/// A page's address or a tool's name.
pub fn source_text(w: &Watcher) -> String {
    let key = if is_page(w) { "url" } else { "tool" };
    w.source
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .into()
}

pub fn is_page(w: &Watcher) -> bool {
    w.source.get("kind").and_then(|v| v.as_str()) != Some("tool")
}

pub fn renders(w: &Watcher) -> bool {
    w.source.get("render").and_then(|v| v.as_bool()) == Some(true)
}

pub fn watcher_line(w: &Watcher) -> String {
    if !w.enabled {
        return "Off".into();
    }
    if let Some(e) = &w.last_error {
        return e.clone();
    }
    format!(
        "{}, {}",
        condition(&w.condition),
        every(w.every_minutes).to_lowercase()
    )
}

/// What switching "Run the page's scripts" sends: a page that runs them looks every 15 minutes at
/// most.
pub fn render_change(w: &Watcher, on: bool) -> Value {
    let mut source: Map<String, Value> = w.source.clone();
    if on {
        source.insert("render".into(), json!(true));
    } else {
        source.remove("render");
    }
    let mut change = json!({ "source": source });
    if on && w.every_minutes < 15 {
        change["everyMinutes"] = json!(15);
    }
    change
}

/// "Disk nearly full, told you".
pub fn heartbeat_line(run: &HeartbeatRun) -> String {
    let mut line = if run.found.is_empty() {
        "Nothing".to_string()
    } else {
        run.found.join(", ")
    };
    match run.action.as_deref() {
        Some("notify") => line += ", told you",
        Some("task") => line += ", started a task",
        _ => {}
    }
    line
}

pub fn answer(a: &Approval) -> String {
    let mut text = match a.status {
        ApprovalStatus::Pending => return "Waiting for your answer".into(),
        ApprovalStatus::Approved => "Approved".to_string(),
        ApprovalStatus::Denied => "Denied".into(),
        ApprovalStatus::Expired => "Expired".into(),
        ApprovalStatus::Cancelled => "Replaced".into(),
        ApprovalStatus::Unknown => return String::new(),
    };
    if a.decided_via.as_deref() == Some("ntfy") {
        text += " from the notification";
    }
    if let Some(at) = &a.decided_at {
        text += &format!(", {}", format::stamp(at));
    }
    text
}

/// A limit as typed: digits and one decimal mark, a point or a comma. None when it can't be read.
pub fn dollars(text: &str) -> Option<f64> {
    let kept: String = text
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
        .map(|c| if c == ',' { '.' } else { c })
        .collect();
    if kept.matches('.').count() > 1 || !kept.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    kept.parse().ok()
}

/// A limit to edit: up to two decimals, no grouping.
pub fn dollars_text(usd: f64) -> String {
    let s = format!("{:.2}", (usd * 100.0).round() / 100.0);
    s.trim_end_matches('0').trim_end_matches('.').into()
}

/// What a limit's field means: its old value while it still shows that, so $0.125 shown as 0.13
/// isn't a change.
pub fn limit(text: &str, old: f64) -> Option<f64> {
    if text.trim() == dollars_text(old) {
        Some(old)
    } else {
        dollars(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intervals_read_in_the_largest_whole_unit() {
        assert_eq!(every(60), "Every hour");
        assert_eq!(every(90), "Every 90 minutes");
        assert_eq!(every(2880), "Every 2 days");
        assert_eq!(every_choices(20), [5, 10, 15, 20, 30, 60, 120, 240]);
    }

    #[test]
    fn running_a_pages_scripts_looks_every_15_minutes_at_most() {
        let w: Watcher = serde_json::from_value(json!({
            "id": 1, "botId": "hatbot", "name": "Price", "source": {"kind": "page", "url": "https://x.example"},
            "condition": {"when": "changed"}, "everyMinutes": 5, "enabled": true
        }))
        .unwrap();
        assert_eq!(
            render_change(&w, true),
            json!({"source": {"kind": "page", "url": "https://x.example", "render": true}, "everyMinutes": 15})
        );
        let hourly = Watcher {
            every_minutes: 60,
            ..w
        };
        assert_eq!(render_change(&hourly, true).get("everyMinutes"), None);
    }

    #[test]
    fn a_limit_still_showing_its_rounded_value_is_unchanged() {
        assert_eq!(limit("0.13", 0.125), Some(0.125));
        assert_eq!(limit("2,5", 3.0), Some(2.5));
        assert_eq!(limit("1.2.3", 3.0), None);
    }
}
