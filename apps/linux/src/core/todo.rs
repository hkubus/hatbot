// The to-do list (Todo.swift and TodoView.swift on iOS): open items in the file's order, then what
// was done this week, latest first.
use super::models::Todo;

pub fn split(items: &[Todo]) -> (Vec<&Todo>, Vec<&Todo>) {
    let open = items.iter().filter(|t| !t.done).collect();
    let done = items.iter().rev().filter(|t| t.done).collect();
    (open, done)
}

/// "25 Oct" for "2026-10-25"; anything else as it came.
pub fn day(ymd: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let mut it = ymd.splitn(3, '-');
    let (Some(_), Some(m), Some(d)) = (it.next(), it.next(), it.next()) else {
        return ymd.into();
    };
    match (m.parse::<usize>(), d.parse::<u32>()) {
        (Ok(m @ 1..=12), Ok(d)) => format!("{d} {}", MONTHS[m - 1]),
        _ => ymd.into(),
    }
}

/// When it's due, and whether that's gone by, against `today` ("2026-10-21").
pub fn due(t: &Todo, today: &str) -> Option<(String, bool)> {
    let due = t.due.as_deref()?;
    if due < today {
        return Some((format!("Overdue, {}", day(due)), true));
    }
    let mut text = if due == today {
        "Today".to_string()
    } else {
        day(due)
    };
    if let Some(at) = &t.at {
        text += &format!(" {at}");
    }
    Some((text, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_day_gone_by_is_overdue_and_today_keeps_its_time() {
        let item = |due: &str| Todo {
            line: 2,
            done: false,
            text: "Call the plumber".into(),
            due: Some(due.into()),
            at: Some("14:00".into()),
            done_on: None,
            task_id: None,
        };
        assert_eq!(
            due(&item("2026-10-20"), "2026-10-21"),
            Some(("Overdue, 20 Oct".into(), true))
        );
        assert_eq!(
            due(&item("2026-10-21"), "2026-10-21"),
            Some(("Today 14:00".into(), false))
        );
    }
}
