// Automations: schedules, watchers and triggers, and the jobs built in.
use iced::widget::{column, container, row, text, text_editor};
use iced::{Alignment, Element, Length, Task};
use serde_json::{Value, json};

use super::Msg as PageMsg;
use crate::core::format;
use crate::core::models::Task as AgentTask;
use crate::core::models::*;
use crate::ui::app::{Message, Route, Session, failed};
use crate::ui::icons::{self, Icon};
use crate::ui::theme::{self, FS_LG, FS_MD, SP, SP_LG, SP_PAGE, SP_SM, SP_XS};
use crate::ui::widgets::{
    Choice, area, btn, btn_icon, btn_sm, empty_tile, error, field, fill, group, heading, icon_btn_sized, input,
    link_line, link_tiles_with, page, picker, segmented, select, small, switch, switch_row, tiles, tone,
};

pub fn bot_choices(s: &Session) -> Vec<Choice> {
    s.store
        .bot_ids
        .iter()
        .filter_map(|id| s.store.bots.get(id))
        .map(|b| Choice { id: b.id.clone(), name: b.name.clone() })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Copy)]
pub enum When {
    Repeats,
    Once,
}

pub struct Form {
    id: Option<i64>,
    name: String,
    when: When,
    cron: String,
    at: String,
    prompt: text_editor::Content,
    enabled: bool,
    bot: String,
}

type Automations = (Vec<Schedule>, Vec<Trigger>, Vec<Watcher>);

#[derive(Debug, Clone)]
pub enum Msg {
    Loaded(Result<Automations, String>),
    New,
    Edit(i64),
    Close,
    Name(String),
    When(When),
    Cron(String),
    At(String),
    Prompt(text_editor::Action),
    Enabled(bool),
    Bot(Choice),
    Save,
    Saved(Result<Schedule, String>),
    Run(i64),
    Started(Result<AgentTask, String>),
    Delete(i64),
    ScheduleOn(i64, bool),
    WatcherOn(i64, bool),
    Check(i64),
    DeleteWatcher(i64),
    TriggerOn(i64, bool),
    DeleteTrigger(i64),
    Setting(SettingsChange),
    SendReport,
}

#[derive(Default)]
pub struct State {
    loaded: bool,
    error: Option<String>,
    form: Option<Form>,
    busy: bool,
}

fn m(msg: Msg) -> Message {
    Message::Page(PageMsg::Schedules(msg))
}

pub fn opened(s: &mut Session) -> Task<Message> {
    s.pages.schedules.form = None;
    load(s)
}

fn load(s: &Session) -> Task<Message> {
    Task::batch([
        s.call(
            |api| async move {
                let a: Vec<Schedule> = api.get("/schedules").await?;
                let b: Vec<Trigger> = api.get("/triggers").await?;
                let c: Vec<Watcher> = api.get("/watchers").await.unwrap_or_default();
                Ok((a, b, c))
            },
            |r| match r {
                Err(e) if e.is_unauthorized() => Message::Unauthorized,
                r => m(Msg::Loaded(r.map_err(|e| e.message))),
            },
        ),
        crate::ui::app::load_settings(s),
    ])
}

/// A call whose answer is the thing it changed, which the stream brings anyway.
fn act<T: serde::de::DeserializeOwned + Send + 'static>(
    s: &Session,
    f: impl FnOnce(crate::core::api::Api) -> futures::future::BoxFuture<'static, Result<T, crate::core::api::ApiError>>,
) -> Task<Message> {
    s.call(f, |r| r.map(|_| Message::Nothing).unwrap_or_else(failed))
}

pub fn update(s: &mut Session, msg: Msg) -> Task<Message> {
    use futures::FutureExt;
    let st = &mut s.pages.schedules;
    match msg {
        Msg::Loaded(Ok((a, b, c))) => {
            st.loaded = true;
            st.error = None;
            s.store.schedules = a.into_iter().map(|x| (x.id, x)).collect();
            s.store.triggers = b.into_iter().map(|x| (x.id, x)).collect();
            s.store.watchers = c.into_iter().map(|x| (x.id, x)).collect();
        }
        Msg::Loaded(Err(e)) => st.error = Some(e),
        Msg::New => {
            st.form = Some(Form {
                id: None,
                name: String::new(),
                when: When::Repeats,
                cron: "0 8 * * *".into(),
                at: String::new(),
                prompt: text_editor::Content::new(),
                enabled: true,
                bot: "hatbot".into(),
            })
        }
        Msg::Edit(id) => {
            if let Some(x) = s.store.schedules.get(&id) {
                s.pages.schedules.form = Some(Form {
                    id: Some(id),
                    name: x.name.clone(),
                    when: if x.cron.is_some() { When::Repeats } else { When::Once },
                    cron: x.cron.clone().unwrap_or_else(|| "0 8 * * *".into()),
                    at: x.run_at.as_deref().map(format::iso_to_local).unwrap_or_default(),
                    prompt: text_editor::Content::with_text(&x.prompt),
                    enabled: x.enabled,
                    bot: x.bot_id.clone(),
                });
            }
        }
        Msg::Close => st.form = None,
        Msg::Name(v) => with(st, |f| f.name = v),
        Msg::When(v) => with(st, |f| f.when = v),
        Msg::Cron(v) => with(st, |f| f.cron = v),
        Msg::At(v) => with(st, |f| f.at = v),
        Msg::Prompt(a) => with(st, |f| f.prompt.perform(a)),
        Msg::Enabled(v) => with(st, |f| f.enabled = v),
        Msg::Bot(c) => with(st, |f| f.bot = c.id),
        Msg::Save => {
            let Some(f) = &st.form else { return Task::none() };
            let mut body = json!({
                "name": f.name.trim(),
                "prompt": f.prompt.text().trim(),
                "enabled": f.enabled,
                "botId": f.bot,
            });
            match f.when {
                When::Repeats => body["cron"] = Value::String(f.cron.trim().into()),
                When::Once => match format::local_to_iso(&f.at) {
                    Some(at) => body["at"] = Value::String(at),
                    None => {
                        st.error = Some("Give a time to come, as 2026-11-02 08:00.".into());
                        return Task::none();
                    }
                },
            }
            st.busy = true;
            st.error = None;
            let id = f.id;
            return s.call(
                move |api| async move {
                    match id {
                        Some(id) => api.patch::<Schedule, _>(&format!("/schedules/{id}"), &body).await,
                        None => api.post::<Schedule, _>("/schedules", &body).await,
                    }
                },
                |r| m(Msg::Saved(r.map_err(|e| e.message))),
            );
        }
        Msg::Saved(Ok(x)) => {
            st.busy = false;
            st.form = None;
            s.store.schedules.insert(x.id, x);
        }
        Msg::Saved(Err(e)) => {
            st.busy = false;
            st.error = Some(e);
        }
        Msg::Run(id) => {
            return s.call(
                move |api| async move { api.post::<AgentTask, _>(&format!("/schedules/{id}/run"), &json!({})).await },
                |r| m(Msg::Started(r.map_err(|e| e.message))),
            );
        }
        Msg::Started(Ok(t)) => {
            let id = t.id;
            s.store.take_task(t);
            return Task::done(Message::Go(Route::Task(id)));
        }
        Msg::Started(Err(e)) => return Task::done(Message::Toast(e)),
        Msg::Delete(id) => {
            st.form = None;
            s.store.schedules.remove(&id);
            return s.fire(move |api| async move { api.delete(&format!("/schedules/{id}")).await });
        }
        Msg::ScheduleOn(id, on) => {
            if let Some(x) = s.store.schedules.get_mut(&id) {
                x.enabled = on;
            }
            return act::<Schedule>(s, move |api| {
                async move { api.patch(&format!("/schedules/{id}"), &json!({ "enabled": on })).await }.boxed()
            });
        }
        Msg::WatcherOn(id, on) => {
            if let Some(x) = s.store.watchers.get_mut(&id) {
                x.enabled = on;
            }
            return act::<Watcher>(s, move |api| {
                async move { api.patch(&format!("/watchers/{id}"), &json!({ "enabled": on })).await }.boxed()
            });
        }
        Msg::Check(id) => {
            return act::<Watcher>(s, move |api| {
                async move { api.post(&format!("/watchers/{id}/check"), &json!({})).await }.boxed()
            });
        }
        Msg::DeleteWatcher(id) => {
            s.store.watchers.remove(&id);
            return s.fire(move |api| async move { api.delete(&format!("/watchers/{id}")).await });
        }
        Msg::TriggerOn(id, on) => {
            if let Some(x) = s.store.triggers.get_mut(&id) {
                x.enabled = on;
            }
            return act::<Trigger>(s, move |api| {
                async move { api.patch(&format!("/triggers/{id}"), &json!({ "enabled": on })).await }.boxed()
            });
        }
        Msg::DeleteTrigger(id) => {
            s.store.triggers.remove(&id);
            return s.fire(move |api| async move { api.delete(&format!("/triggers/{id}")).await });
        }
        Msg::Setting(change) => return save_setting(s, change),
        Msg::SendReport => {
            return s.call(
                |api| async move { api.post::<Value, _>("/report/send", &json!({})).await },
                |r| match r {
                    Ok(_) => Message::Toast("Sent to Hatbot's chat.".into()),
                    Err(e) => failed(e),
                },
            );
        }
    }
    Task::none()
}

fn with(st: &mut State, f: impl FnOnce(&mut Form)) {
    if let Some(form) = &mut st.form {
        f(form);
    }
}

/// A setting changes on screen at once and is saved behind it; the answer brings them all.
pub fn save_setting(s: &mut Session, change: SettingsChange) -> Task<Message> {
    if let Some(cur) = &mut s.settings {
        apply(cur, &change);
    }
    s.call(
        move |api| async move { api.patch::<AppSettings, _>("/settings", &change).await },
        |r| match r {
            Ok(a) => Message::Loaded(crate::ui::app::Loaded::Settings(a)),
            Err(e) => failed(e),
        },
    )
}

fn apply(a: &mut AppSettings, c: &SettingsChange) {
    macro_rules! set {
        ($($f:ident),*) => { $( if let Some(v) = &c.$f { a.$f = Some(v.clone()); } )* };
    }
    set!(
        limits,
        chat_effort,
        chat_model,
        review_changes,
        desktop_model,
        desktop_escalate,
        task_model,
        small_model,
        expert_model,
        weekly_report,
        todo_hour,
        memory_tidy
    );
}

pub fn hours() -> Vec<Hour> {
    (0..24).map(Hour).collect()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hour(pub i64);

impl std::fmt::Display for Hour {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:02}:00", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Day(i64);

impl std::fmt::Display for Day {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(format::DAYS[self.0.clamp(0, 6) as usize])
    }
}

pub fn view(s: &Session) -> Element<'_, Message> {
    let st = &s.pages.schedules;
    if let Some(f) = &st.form {
        return editor(s, f, st);
    }
    let mut col =
        column![row![fill(), btn_icon(Icon::Plus, "Schedule", theme::outlined, icons::text, Some(m(Msg::New)))]]
            .spacing(SP_PAGE);
    if let Some(e) = &st.error {
        col = col.push(error(e.as_str()));
    }
    col = col.push(built_in(s));
    if !st.loaded {
        return page(col);
    }

    let mut schedules: Vec<&Schedule> = s.store.schedules.values().collect();
    schedules.sort_by(|a, b| a.name.cmp(&b.name));
    let rows = schedules
        .into_iter()
        .map(|x| {
            let id = x.id;
            let value = if x.enabled { format::when(x.cron.as_deref(), x.run_at.as_deref()) } else { "Off".into() };
            (
                link_line(x.name.as_str(), Some(value)),
                m(Msg::Edit(id)),
                Some(switch(x.enabled, Some(m(Msg::ScheduleOn(id, !x.enabled))))),
            )
        })
        .collect::<Vec<_>>();
    col = col.push(titled(
        "Schedules",
        if rows.is_empty() {
            empty_tile("None yet. Add one here, or ask Hatbot in chat.")
        } else {
            link_tiles_with(rows)
        },
    ));

    let mut watchers: Vec<&Watcher> = s.store.watchers.values().collect();
    watchers.sort_by(|a, b| a.name.cmp(&b.name));
    let rows: Vec<Element<'_, Message>> = watchers
        .into_iter()
        .map(|w| {
            let id = w.id;
            let value = match (&w.last_error, w.enabled) {
                (Some(e), _) => e.clone(),
                (None, true) => w.last_value.clone().unwrap_or_default(),
                (None, false) => "Off".into(),
            };
            row![
                text(w.name.as_str()).size(FS_LG).width(Length::Fill),
                text(value).size(FS_MD).style(tone(if w.last_error.is_some() { |c| c.danger } else { |c| c.text_2 })),
                icon_btn_sized(Icon::Retry, "Check now", Some(m(Msg::Check(id))), 20.0),
                icon_btn_sized(Icon::Trash, "Delete", Some(m(Msg::DeleteWatcher(id))), 20.0),
                switch(w.enabled, Some(m(Msg::WatcherOn(id, !w.enabled))))
            ]
            .spacing(SP_XS)
            .align_y(Alignment::Center)
            .into()
        })
        .collect();
    col = col.push(titled(
        "Watchers",
        if rows.is_empty() { empty_tile("None yet. Ask Hatbot in chat.") } else { tiles(rows) },
    ));

    let mut triggers: Vec<&Trigger> = s.store.triggers.values().collect();
    triggers.sort_by(|a, b| a.name.cmp(&b.name));
    let rows: Vec<Element<'_, Message>> = triggers
        .into_iter()
        .map(|t| {
            let id = t.id;
            let kind = if t.kind == TriggerKind::Kuma { "Uptime Kuma" } else { "Webhook" };
            row![
                text(t.name.as_str()).size(FS_LG).width(Length::Fill),
                text(if t.enabled { kind } else { "Off" }).size(FS_MD).style(tone(|c| c.text_2)),
                icon_btn_sized(Icon::Trash, "Delete", Some(m(Msg::DeleteTrigger(id))), 20.0),
                switch(t.enabled, Some(m(Msg::TriggerOn(id, !t.enabled))))
            ]
            .spacing(SP_XS)
            .align_y(Alignment::Center)
            .into()
        })
        .collect();
    col = col.push(titled(
        "Triggers",
        if rows.is_empty() { empty_tile("None yet. Add them on the web.") } else { tiles(rows) },
    ));
    page(col)
}

/// A group's title over its tiles, as the web's `Group`.
fn titled<'a>(name: &'a str, tiles: Element<'a, Message>) -> Element<'a, Message> {
    column![container(heading(name)).padding([0.0, SP_LG]), tiles].spacing(SP_SM).into()
}

fn built_in(s: &Session) -> Element<'_, Message> {
    let Some(a) = &s.settings else { return column![].into() };
    let mut col: Vec<Element<'_, Message>> = Vec::new();
    if let Some(h) = &a.heartbeat {
        col.push(link_line("Heartbeat", Some(if h.enabled { format::every(h.every_minutes) } else { "Off".into() })));
    }
    if let Some(r) = &a.weekly_report {
        let r2 = r.clone();
        col.push(switch_row(
            "Weekly report",
            None,
            r.enabled,
            Some(move |on| {
                m(Msg::Setting(SettingsChange {
                    weekly_report: Some(WeeklyReport { enabled: on, ..r2.clone() }),
                    ..Default::default()
                }))
            }),
        ));
        if r.enabled {
            let (r3, r4) = (r.clone(), r.clone());
            col.push(
                row![
                    text("Sent on").size(FS_LG).width(Length::Fill),
                    select((0..7).map(Day).collect(), Some(Day(r.weekday)), move |d| {
                        m(Msg::Setting(SettingsChange {
                            weekly_report: Some(WeeklyReport { weekday: d.0, ..r3.clone() }),
                            ..Default::default()
                        }))
                    }),
                    select(hours(), Some(Hour(r.hour)), move |h| {
                        m(Msg::Setting(SettingsChange {
                            weekly_report: Some(WeeklyReport { hour: h.0, ..r4.clone() }),
                            ..Default::default()
                        }))
                    }),
                    btn_sm("Send now", theme::outlined, Some(m(Msg::SendReport)))
                ]
                .spacing(SP_LG)
                .align_y(Alignment::Center)
                .into(),
            );
        }
    }
    group("Built in", col)
}

fn editor<'a>(s: &'a Session, f: &'a Form, st: &'a State) -> Element<'a, Message> {
    let bots = bot_choices(s);
    let current = bots.iter().find(|b| b.id == f.bot).cloned();
    let mut col = column![
        text(if f.id.is_none() { "New schedule" } else { "Schedule" }).size(theme::FS_XL),
        field("Name", input("", &f.name, |v| m(Msg::Name(v)))),
        switch_row("On", None, f.enabled, Some(|on| m(Msg::Enabled(on)))),
    ]
    .spacing(SP_LG);
    if bots.len() > 1 {
        col = col.push(picker("Runs as", bots, current, |c| m(Msg::Bot(c))));
    }
    col = col.push(segmented(&[("Repeats", When::Repeats), ("Once", When::Once)], f.when, |w| m(Msg::When(w))));
    col = match f.when {
        When::Repeats => col.push(
            column![
                field("Cron", input("0 8 * * *", &f.cron, |v| m(Msg::Cron(v)))),
                small(format!(
                    "{}. Minute, hour, day of month, month, day of week, in the brain's time zone.",
                    format::describe_cron(&f.cron)
                ))
            ]
            .spacing(SP),
        ),
        When::Once => col.push(field("At", input("2026-11-02 08:00", &f.at, |v| m(Msg::At(v))))),
    };
    col = col.push(field(
        "What it does",
        area(&f.prompt, "Everything the run needs to know: it can't see the chat.", |a| m(Msg::Prompt(a))),
    ));
    if let Some(id) = f.id
        && let Some(x) = s.store.schedules.get(&id)
    {
        if let Some(next) = &x.next_run_at {
            col = col.push(small(format!("Next run {}", format::stamp(next))));
        }
        if let Some(t) = x.last_task_id {
            col = col.push(btn_sm("Last run", theme::link, Some(Message::Go(Route::Task(t)))));
        }
    }
    if let Some(e) = &st.error {
        col = col.push(error(e.as_str()));
    }
    let ready = !st.busy && !f.name.trim().is_empty() && !f.prompt.text().trim().is_empty();
    let mut buttons = row![btn("Cancel", theme::plain, Some(m(Msg::Close)))].spacing(SP);
    if let Some(id) = f.id {
        buttons = buttons.push(btn("Delete", theme::danger, Some(m(Msg::Delete(id))))).push(btn(
            "Run now",
            theme::outlined,
            Some(m(Msg::Run(id))),
        ));
    }
    buttons = buttons.push(fill()).push(btn("Save", theme::primary, ready.then_some(m(Msg::Save))));
    col = col.push(buttons);
    page(col)
}
