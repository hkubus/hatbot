// As iOS's Format.swift has them; cron in words is describeCron in packages/shared.
use jiff::{Timestamp, Zoned, tz::TimeZone};

use super::models::{Task, TaskStatus};

/// The brain's timestamps (ISO 8601 in UTC), in local time.
pub fn date(iso: &str) -> Option<Zoned> {
    let ts: Timestamp = iso.parse().ok()?;
    Some(ts.to_zoned(TimeZone::system()))
}

pub fn now() -> Zoned {
    Zoned::now()
}

fn fmt(d: &Zoned, pattern: &str) -> String {
    d.strftime(pattern).to_string()
}

/// "14:05".
pub fn time_text(iso: &str) -> String {
    date(iso).map(|d| fmt(&d, "%H:%M")).unwrap_or_default()
}

/// The label over a message that comes an hour or more after the one before it: "Today 14:05",
/// "Yesterday 14:05", "Monday 14:05" within the week, "Mon 12 Oct at 14:05", "12 Oct 2025 at 14:05".
pub fn pause(at: &Zoned, previous: Option<&Zoned>, now: &Zoned) -> Option<String> {
    if previous.is_some_and(|p| at.timestamp().as_second() - p.timestamp().as_second() < 3600) {
        return None;
    }
    let time = fmt(at, "%H:%M");
    let (day, today) = (at.date(), now.date());
    if day == today {
        return Some(format!("Today {time}"));
    }
    if today.yesterday().is_ok_and(|y| y == day) {
        return Some(format!("Yesterday {time}"));
    }
    if today.checked_sub(jiff::Span::new().days(6)).is_ok_and(|w| day >= w) {
        return Some(format!("{} {time}", fmt(at, "%A")));
    }
    let label = if day.year() == today.year() { fmt(at, "%a %-d %b") } else { fmt(at, "%-d %b %Y") };
    Some(format!("{label} at {time}"))
}

/// The time today, otherwise the day and time: "14:05", "14 Oct, 09:05".
pub fn stamp(iso: &str) -> String {
    let Some(d) = date(iso) else { return String::new() };
    if d.date() == now().date() { fmt(&d, "%H:%M") } else { fmt(&d, "%-d %b, %H:%M") }
}

pub fn money(usd: f64) -> String {
    format!("${usd:.2}")
}

/// Dollars as typed, "$12.50" or "12,5"; None when it isn't a number.
pub fn amount(text: &str) -> Option<f64> {
    let t = text.trim().trim_start_matches('$').trim().replace(',', ".");
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// An amount to edit: "12.5", "20".
pub fn amount_text(usd: f64) -> String {
    let s = format!("{usd:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// "Opus 5.5" for claude-opus-5-5, worked out from the id so a new model has a name too; an id of
/// another shape stays as it is.
pub fn model_name(id: &str) -> String {
    let digits =
        |s: &str, n: std::ops::RangeInclusive<usize>| n.contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
    let parts: Vec<&str> = id.split('-').collect();
    let (family, major, rest) = match parts.as_slice() {
        ["claude", family, major, rest @ ..]
            if !family.is_empty() && family.bytes().all(|b| b.is_ascii_lowercase()) && digits(major, 1..=9) =>
        {
            (*family, *major, rest)
        }
        _ => return id.into(),
    };
    let minor = match rest {
        [] => None,
        [d] if digits(d, 8..=8) => None,
        [m] if digits(m, 1..=2) => Some(*m),
        [m, d] if digits(m, 1..=2) && digits(d, 8..=8) => Some(*m),
        _ => return id.into(),
    };
    let mut name = family[..1].to_uppercase() + &family[1..] + " " + major;
    if let Some(m) = minor {
        name += &format!(".{m}");
    }
    name
}

pub fn status_label(s: TaskStatus) -> &'static str {
    match s {
        TaskStatus::Queued => "Queued",
        TaskStatus::Running => "Running",
        TaskStatus::WaitingApproval => "Needs approval",
        TaskStatus::WaitingTakeover => "Needs you",
        TaskStatus::WaitingAnswer => "Asks you",
        TaskStatus::Done => "Done",
        TaskStatus::Failed => "Failed",
        TaskStatus::Cancelled => "Cancelled",
    }
}

/// 950, 12.4k, 3.1M.
pub fn tokens(n: i64) -> String {
    if n < 1000 {
        n.to_string()
    } else if n < 1_000_000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    }
}

/// The last line Hatbot wrote or thought.
pub fn last_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).rfind(|l| !l.is_empty())
}

pub fn task_line(t: &Task, progress: Option<&str>) -> String {
    if let Some(summary) = &t.summary
        && !t.status.is_active()
    {
        return summary.clone();
    }
    match t.status {
        TaskStatus::Queued if t.lane == "screen" => "Waiting for the screen.".into(),
        TaskStatus::Queued => "Queued.".into(),
        TaskStatus::WaitingApproval => "Waiting for your approval.".into(),
        TaskStatus::WaitingTakeover => "Waiting for you to take over.".into(),
        TaskStatus::WaitingAnswer => "Waiting for your answer.".into(),
        _ => progress.and_then(last_line).unwrap_or("Working…").into(),
    }
}

/// "Every day at 08:00", or "Once, Sat 11 Oct, 08:00".
pub fn when(cron: Option<&str>, run_at: Option<&str>) -> String {
    if let Some(cron) = cron {
        return describe_cron(cron);
    }
    run_at.and_then(date).map(|d| format!("Once, {}", fmt(&d, "%a %-d %b, %H:%M"))).unwrap_or_default()
}

/// "Every 15 minutes", "Every hour", "Every 2 days".
pub fn every(minutes: i64) -> String {
    let unit = |n: i64, word: &str| if n == 1 { format!("Every {word}") } else { format!("Every {n} {word}s") };
    if minutes > 0 && minutes % 1440 == 0 {
        unit(minutes / 1440, "day")
    } else if minutes > 0 && minutes % 60 == 0 {
        unit(minutes / 60, "hour")
    } else {
        unit(minutes, "minute")
    }
}

/// "2026-11-02 08:00" in local time, as the brain's ISO 8601; None when it isn't that, or is past.
pub fn local_to_iso(text: &str) -> Option<String> {
    let dt: jiff::civil::DateTime = jiff::civil::DateTime::strptime("%Y-%m-%d %H:%M", text.trim()).ok()?;
    let z = dt.to_zoned(TimeZone::system()).ok()?;
    (z.timestamp() > Timestamp::now()).then(|| z.timestamp().to_string())
}

/// An ISO 8601 date as "2026-11-02 08:00" in local time, to edit.
pub fn iso_to_local(iso: &str) -> String {
    date(iso).map(|d| fmt(&d, "%Y-%m-%d %H:%M")).unwrap_or_default()
}

/// A to-do's due date as it shows: "Today", "25 Oct", with its time if it has one. True when it's past.
pub fn due(ymd: &str, at: Option<&str>) -> (String, bool) {
    let Ok(d) = ymd.parse::<jiff::civil::Date>() else { return (ymd.to_string(), false) };
    let today = now().date();
    if d < today {
        return (format!("Overdue, {}", d.strftime("%-d %b")), true);
    }
    let day = if d == today { "Today".to_string() } else { d.strftime("%-d %b").to_string() };
    (at.map(|t| format!("{day} {t}")).unwrap_or(day), false)
}

/// "2026-11-02" as typed, when it's a real date.
pub fn ymd(text: &str) -> Option<String> {
    text.trim().parse::<jiff::civil::Date>().ok().map(|d| d.to_string())
}

/// A search snippet split at its matches, which the brain puts between \u{2} and \u{3}: (text, matched).
pub fn snippet(text: &str) -> Vec<(&str, bool)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find('\u{2}') {
        if start > 0 {
            out.push((&rest[..start], false));
        }
        let after = &rest[start + 1..];
        let end = after.find('\u{3}').unwrap_or(after.len());
        if end > 0 {
            out.push((&after[..end], true));
        }
        rest = after.get(end + 1..).unwrap_or("");
    }
    if !rest.is_empty() {
        out.push((rest, false));
    }
    out
}

pub const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

fn num(s: &str) -> Option<u32> {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) { s.parse().ok() } else { None }
}

fn ordinal(n: u32) -> String {
    let suffix = match (n % 10, n % 100) {
        (1, 11) | (2, 12) | (3, 13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

fn list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn step(s: &str) -> Option<&str> {
    s.strip_prefix("*/").filter(|n| num(n).is_some())
}

/// "Every day at 08:00", "Weekdays at 07:30", "Every 15 minutes"; the expression itself when it's unusual.
pub fn describe_cron(expr: &str) -> String {
    let trimmed = expr.trim();
    let expanded = match trimmed.to_lowercase().as_str() {
        "@hourly" => "0 * * * *",
        "@daily" | "@midnight" => "0 0 * * *",
        "@weekly" => "0 0 * * 0",
        "@monthly" => "0 0 1 * *",
        "@yearly" | "@annually" => "0 0 1 1 *",
        _ => trimmed,
    };
    let fields: Vec<&str> = expanded.split(' ').filter(|f| !f.is_empty()).collect();
    let [min, hour, dom, mon, dow] = fields[..] else {
        return expr.into();
    };

    if hour == "*" && dom == "*" && mon == "*" && dow == "*" {
        if min == "*" {
            return "Every minute".into();
        }
        if let Some(n) = step(min) {
            return format!("Every {n} minutes");
        }
        if let Some(m) = num(min) {
            return if m == 0 { "Every hour".into() } else { format!("Every hour at :{m:02}") };
        }
    }
    let (Some(m), "*") = (num(min), mon) else {
        return expr.into();
    };
    if let (Some(n), "*", "*") = (step(hour), dom, dow) {
        return format!("Every {n} hours");
    }
    let Some(hours) = hour.split(',').map(num).collect::<Option<Vec<_>>>() else {
        return expr.into();
    };
    let at = format!("at {}", list(&hours.iter().map(|h| format!("{h:02}:{m:02}")).collect::<Vec<_>>()));

    if dom == "*" && dow == "*" {
        return format!("Every day {at}");
    }
    if dom == "*" {
        if dow == "1-5" {
            return format!("Weekdays {at}");
        }
        if ["0,6", "6,0", "6-7"].contains(&dow) {
            return format!("Weekends {at}");
        }
        let Some(days) = dow.split(',').map(|d| num(d).filter(|&n| n <= 7)).collect::<Option<Vec<_>>>() else {
            return expr.into();
        };
        let names: Vec<&str> = days.iter().map(|&d| DAYS[d as usize % 7]).collect();
        if let [one] = names[..] {
            return format!("Every {one} {at}");
        }
        return format!("{} {at}", list(&names.iter().map(|n| n[..3].to_string()).collect::<Vec<_>>()));
    }
    if dow == "*"
        && let Some(day) = num(dom).filter(|d| (1..=31).contains(d))
    {
        return format!("{} of the month {at}", ordinal(day));
    }
    expr.into()
}
