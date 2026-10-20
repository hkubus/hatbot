// A schedule as its form edits it (ScheduleForm.swift on iOS).
use gtk::glib::DateTime;
use serde::Serialize;

use super::format;
use super::models::Schedule;

const CRON: &str = "0 8 * * *";

#[derive(Clone, Debug)]
pub struct ScheduleForm {
    pub name: String,
    pub repeats: bool,
    pub cron: String,
    /// When a one-off runs, in local time.
    pub at: DateTime,
    pub prompt: String,
    pub enabled: bool,
    pub bot_id: String,
}

/// What's sent: fields left out aren't changed.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleChange {
    pub name: String,
    pub prompt: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    pub bot_id: String,
}

/// An hour from now, on the minute.
fn in_an_hour() -> DateTime {
    let now = DateTime::now_local().expect("the time");
    let d = now.add_hours(1).expect("an hour on");
    d.add_seconds(-(d.seconds())).unwrap_or(d)
}

impl Default for ScheduleForm {
    fn default() -> Self {
        ScheduleForm {
            name: String::new(),
            repeats: true,
            cron: CRON.into(),
            at: in_an_hour(),
            prompt: String::new(),
            enabled: true,
            bot_id: "hatbot".into(),
        }
    }
}

impl From<&Schedule> for ScheduleForm {
    fn from(s: &Schedule) -> Self {
        ScheduleForm {
            name: s.name.clone(),
            repeats: s.cron.is_some(),
            cron: s.cron.clone().unwrap_or_else(|| CRON.into()),
            at: s
                .run_at
                .as_deref()
                .and_then(format::date)
                .unwrap_or_else(in_an_hour),
            prompt: s.prompt.clone(),
            enabled: s.enabled,
            bot_id: s.bot_id.clone(),
        }
    }
}

/// A repeating one's time and a one-off's cron don't count: they aren't sent.
impl PartialEq for ScheduleForm {
    fn eq(&self, o: &Self) -> bool {
        self.name == o.name
            && self.repeats == o.repeats
            && self.prompt == o.prompt
            && self.enabled == o.enabled
            && self.bot_id == o.bot_id
            && if self.repeats {
                self.cron == o.cron
            } else {
                self.at.to_unix() == o.at.to_unix()
            }
    }
}

impl ScheduleForm {
    pub fn change(&self) -> ScheduleChange {
        ScheduleChange {
            name: self.name.trim().into(),
            prompt: self.prompt.trim().into(),
            enabled: self.enabled,
            cron: self.repeats.then(|| self.cron.trim().into()),
            at: (!self.repeats).then(|| {
                self.at
                    .to_utc()
                    .and_then(|d| d.format("%Y-%m-%dT%H:%M:%SZ"))
                    .map(|s| s.to_string())
                    .unwrap_or_default()
            }),
            bot_id: self.bot_id.clone(),
        }
    }

    pub fn valid(&self) -> bool {
        !self.name.trim().is_empty()
            && !self.prompt.trim().is_empty()
            && (!self.repeats || !self.cron.trim().is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_is_sent_counts_as_a_change() {
        let saved = ScheduleForm {
            name: "News".into(),
            prompt: "Tell me the news".into(),
            ..ScheduleForm::default()
        };
        let mut form = saved.clone();
        form.at = form.at.add_days(1).unwrap();
        assert_eq!(form, saved);
        form.repeats = false;
        assert_ne!(form, saved);
        let change = form.change();
        assert_eq!(change.cron, None);
        assert!(change.at.unwrap().ends_with(":00Z"));
    }
}
