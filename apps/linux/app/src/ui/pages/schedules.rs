// Automations: schedules, watchers and triggers, and the jobs built in.
use iced::widget::{column, pick_list, row, text, text_editor};
use iced::{Alignment, Element, Length, Task};
use serde_json::{Value, json};

use super::Msg as PageMsg;
use crate::core::format;
use crate::core::models::Task as AgentTask;
use crate::core::models::*;
use crate::ui::app::{Message, Route, Session, failed};
use crate::ui::theme::{self, FS_LG, FS_SM, SP, SP_LG, SP_MD, SP_XL};
use crate::ui::widgets::{
    area, btn, btn_sm, card, error, field, fill, input, list_row, page, section, segmented, small, switch_row, tone,
};

#[derive(Debug, Clone, PartialEq)]
pub struct Choice {
    pub id: String,
    pub name: String,
}

impl std::fmt::Display for Choice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.name)
    }
}

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

fn hours() -> Vec<Hour> {
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

fn picker<'a, T: ToString + PartialEq + Clone + 'a>(
    name: &'a str,
    options: Vec<T>,
    selected: Option<T>,
    on: impl Fn(T) -> Message + 'a,
) -> Element<'a, Message> {
    row![
        text(name).size(theme::FS_TEXT).width(Length::Fill),
        pick_list(options, selected, on).style(theme::select).padding([8, 14])
    ]
    .align_y(Alignment::Center)
    .spacing(SP_LG)
    .into()
}

pub fn view(s: &Session) -> Element<'_, Message> {
    let st = &s.pages.schedules;
    if let Some(f) = &st.form {
        return editor(s, f, st);
    }
    let mut col = column![].spacing(SP_XL);
    if let Some(e) = &st.error {
        col = col.push(error(e.as_str()));
    }
    col = col.push(built_in(s));

    let mut list = column![].spacing(2);
    if st.loaded && s.store.schedules.is_empty() {
        list = list.push(small("No schedules. Ask Hatbot in the chat, or add one."));
    }
    for x in s.store.schedules.values() {
        let id = x.id;
        list = list.push(item(
            x.name.as_str(),
            if x.enabled { format::when(x.cron.as_deref(), x.run_at.as_deref()) } else { "Off".into() },
            x.enabled,
            Some(m(Msg::Edit(id))),
            move |on| m(Msg::ScheduleOn(id, on)),
        ));
    }
    col = col.push(
        column![
            row![
                text("Schedules").size(theme::FS_MD).font(theme::MEDIUM).style(tone(|c| c.hue)),
                fill(),
                btn_sm("New schedule", theme::tonal, Some(m(Msg::New)))
            ]
            .align_y(Alignment::Center),
            list
        ]
        .spacing(SP_MD),
    );

    let mut watchers = column![].spacing(2);
    if st.loaded && s.store.watchers.is_empty() {
        watchers = watchers.push(small("No watchers. Ask Hatbot in the chat to watch a page or a value."));
    }
    for w in s.store.watchers.values() {
        let id = w.id;
        let line = if !w.enabled {
            "Off".to_string()
        } else if let Some(e) = &w.last_error {
            e.clone()
        } else {
            match &w.last_value {
                Some(v) => format!("{}. Last: {v}", format::every(w.every_minutes)),
                None => format::every(w.every_minutes),
            }
        };
        watchers = watchers.push(
            card(
                column![
                    switch_row(w.name.as_str(), None, w.enabled, Some(move |on| m(Msg::WatcherOn(id, on)))),
                    text(line).size(FS_SM).style(tone(if w.last_error.is_some() { |c| c.danger } else { |c| c.muted })),
                    row![
                        btn_sm("Check now", theme::outlined, Some(m(Msg::Check(id)))),
                        btn_sm("Delete", theme::plain, Some(m(Msg::DeleteWatcher(id))))
                    ]
                    .spacing(SP)
                ]
                .spacing(SP),
            )
            .padding(SP_MD),
        );
    }
    col = col.push(section("Watchers", watchers));

    let mut triggers = column![].spacing(2);
    if st.loaded && s.store.triggers.is_empty() {
        triggers = triggers.push(small("No triggers. Set up webhooks and Uptime Kuma on the web."));
    }
    for t in s.store.triggers.values() {
        let id = t.id;
        triggers = triggers.push(
            card(
                column![
                    switch_row(
                        t.name.as_str(),
                        Some(if t.kind == TriggerKind::Kuma { "Uptime Kuma" } else { "Webhook" }),
                        t.enabled,
                        Some(move |on| m(Msg::TriggerOn(id, on)))
                    ),
                    row![btn_sm("Delete", theme::plain, Some(m(Msg::DeleteTrigger(id))))]
                ]
                .spacing(SP),
            )
            .padding(SP_MD),
        );
    }
    col = col.push(section("Triggers", triggers));
    page(col)
}

fn item<'a>(
    name: &'a str,
    detail: String,
    on: bool,
    open: Option<Message>,
    toggle: impl Fn(bool) -> Message + 'a,
) -> Element<'a, Message> {
    row![
        list_row(
            column![
                text(name).size(FS_LG).style(tone(if on { |c| c.text } else { |c| c.muted })),
                text(detail).size(FS_SM).style(tone(|c| c.muted))
            ]
            .spacing(2),
            open
        ),
        iced::widget::toggler(on).size(24).style(theme::switch).on_toggle(toggle)
    ]
    .spacing(SP_MD)
    .align_y(Alignment::Center)
    .into()
}

fn built_in(s: &Session) -> Element<'_, Message> {
    let Some(a) = &s.settings else { return column![].into() };
    let mut col = column![].spacing(SP_LG);
    if let Some(h) = &a.heartbeat {
        col = col.push(row![
            text("Heartbeat").size(theme::FS_TEXT).width(Length::Fill),
            small(if h.enabled { format::every(h.every_minutes) } else { "Off".into() })
        ]);
    }
    if let Some(r) = &a.weekly_report {
        let r2 = r.clone();
        col = col.push(switch_row(
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
            col = col
                .push(picker("Sent on", (0..7).map(Day).collect(), Some(Day(r.weekday)), move |d| {
                    m(Msg::Setting(SettingsChange {
                        weekly_report: Some(WeeklyReport { weekday: d.0, ..r3.clone() }),
                        ..Default::default()
                    }))
                }))
                .push(picker("Sent at", hours(), Some(Hour(r.hour)), move |h| {
                    m(Msg::Setting(SettingsChange {
                        weekly_report: Some(WeeklyReport { hour: h.0, ..r4.clone() }),
                        ..Default::default()
                    }))
                }))
                .push(row![btn_sm("Send now", theme::outlined, Some(m(Msg::SendReport)))]);
        }
    }
    if let Some(h) = a.todo_hour {
        col = col.push(picker("To-do reminder each morning at", hours(), Some(Hour(h)), |h| {
            m(Msg::Setting(SettingsChange { todo_hour: Some(h.0), ..Default::default() }))
        }));
    }
    if let Some(t) = a.memory_tidy {
        col = col.push(switch_row(
            "Propose a memory tidy-up weekly",
            None,
            t,
            Some(|on| m(Msg::Setting(SettingsChange { memory_tidy: Some(on), ..Default::default() }))),
        ));
    }
    section("Built in", card(col))
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
