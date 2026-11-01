// Settings, in the web's order: models, routines, spending, safety, the account, the theme and pausing.
use iced::widget::{column, container, row, text, text_input};
use iced::{Alignment, Element, Length, Task};

use super::Msg as PageMsg;
use super::schedules::{Hour, hours, save_setting};
use crate::core::models::*;
use crate::core::{format, local};
use crate::ui::app::{App, Message, Session, failed};
use crate::ui::button::button;
use crate::ui::confirm;
use crate::ui::icons::{self, Icon};
use crate::ui::theme::{self, FS_LG, FS_MD, H, SP, SP_LG, SP_MD, SP_PAGE, SP_XS};
use crate::ui::widgets::{Choice, btn_sm, error, group, page, picker, segmented, small, switch_row, tone};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Role {
    Chat,
    Task,
    Desktop,
    Small,
    Expert,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Limit {
    Daily,
    Monthly,
    Task,
    Research,
    Boxes,
    Alerts,
}

#[derive(Debug, Clone)]
pub enum Msg {
    Models(Vec<ModelOption>),
    Tokens(Result<Vec<ApiToken>, String>),
    Model(Role, Choice),
    Effort(Choice),
    Escalate(bool),
    Review(bool),
    Typed(Limit, String),
    SaveLimits,
    MoreLimits(bool),
    Change(SettingsChange),
    Revoke(i64),
    RevokeSure(i64),
    SignOut,
    Lan(bool),
    /// Whether a password is set, asked again before other devices may reach this computer's Hatbot.
    LanAfter(bool),
    LanSet(Result<Option<String>, String>),
    SetPassword,
    OpenWeb,
}

#[derive(Default)]
pub struct State {
    models: Vec<ModelOption>,
    tokens: Option<Vec<ApiToken>>,
    error: Option<String>,
    /// Limits as typed, until saved.
    typed: Vec<(Limit, String)>,
    more_limits: bool,
    /// The web app's address on the network, while the brain on this computer can be reached there.
    lan: Option<String>,
}

fn m(msg: Msg) -> Message {
    Message::Page(PageMsg::Settings(msg))
}

/// The web app, signed in, from the brain on this computer; `to` "setup" sets a password up.
fn open_web(s: &Session, to: &'static str) -> Task<Message> {
    s.call(
        |api| async move { api.post::<LocalLink, _>("/auth/link", &serde_json::json!({})).await },
        move |r| match r {
            Ok(l) => Message::Link(if to.is_empty() { l.url } else { format!("{}?to={to}", l.url) }),
            Err(e) => failed(e),
        },
    )
}

pub fn opened(s: &mut Session) -> Task<Message> {
    s.pages.settings.typed.clear();
    if s.local {
        s.pages.settings.lan = local::lan();
    }
    Task::batch([
        s.call(
            |api| async move { api.get::<Vec<ModelOption>>("/models").await },
            |r| r.map(|l| m(Msg::Models(l))).unwrap_or(Message::Nothing),
        ),
        s.call(
            |api| async move { api.get::<Vec<ApiToken>>("/tokens").await },
            |r| match r {
                Err(e) if e.is_unauthorized() => Message::Unauthorized,
                r => m(Msg::Tokens(r.map_err(|e| e.message))),
            },
        ),
        s.call(
            |api| async move { api.get::<AppSettings>("/settings").await },
            |r| r.map(|a| Message::Loaded(crate::ui::app::Loaded::Settings(a))).unwrap_or(Message::Nothing),
        ),
    ])
}

fn limit_of(l: &Limits, k: Limit) -> Option<f64> {
    match k {
        Limit::Daily => Some(l.daily_usd),
        Limit::Monthly => Some(l.monthly_usd),
        Limit::Task => Some(l.task_usd),
        Limit::Research => Some(l.research_usd),
        Limit::Boxes => l.boxes_usd,
        Limit::Alerts => l.alert_reserve_usd,
    }
}

/// The limits with what's been typed, or None while something typed isn't a number.
fn typed_limits(st: &State, saved: &Limits) -> Option<Limits> {
    let mut l = saved.clone();
    for (k, t) in &st.typed {
        let v = format::amount(t)?;
        match k {
            Limit::Daily => l.daily_usd = v,
            Limit::Monthly => l.monthly_usd = v,
            Limit::Task => l.task_usd = v,
            Limit::Research => l.research_usd = v,
            Limit::Boxes => l.boxes_usd = Some(v),
            Limit::Alerts => l.alert_reserve_usd = Some(v),
        }
    }
    Some(l)
}

pub fn update(s: &mut Session, msg: Msg) -> Task<Message> {
    let st = &mut s.pages.settings;
    match msg {
        Msg::Models(l) => st.models = l,
        Msg::Tokens(Ok(l)) => st.tokens = Some(l),
        Msg::Tokens(Err(e)) => st.error = Some(e),
        Msg::Model(role, c) => {
            let id = Some(c.id);
            let change = match role {
                Role::Chat => SettingsChange { chat_model: id, ..Default::default() },
                Role::Task => SettingsChange { task_model: id, ..Default::default() },
                Role::Desktop => SettingsChange { desktop_model: id, ..Default::default() },
                Role::Small => SettingsChange { small_model: id, ..Default::default() },
                Role::Expert => SettingsChange { expert_model: id, ..Default::default() },
            };
            return save_setting(s, change);
        }
        Msg::Effort(c) => return save_setting(s, SettingsChange { chat_effort: Some(c.id), ..Default::default() }),
        Msg::Escalate(on) => {
            return save_setting(s, SettingsChange { desktop_escalate: Some(on), ..Default::default() });
        }
        Msg::Review(on) => return save_setting(s, SettingsChange { review_changes: Some(on), ..Default::default() }),
        Msg::MoreLimits(open) => st.more_limits = open,
        Msg::Change(c) => return save_setting(s, c),
        Msg::Typed(k, t) => {
            st.typed.retain(|(x, _)| *x != k);
            st.typed.push((k, t));
        }
        Msg::SaveLimits => {
            let Some(saved) = s.settings.as_ref().and_then(|a| a.limits.clone()) else { return Task::none() };
            let Some(l) = typed_limits(st, &saved).filter(Limits::valid) else { return Task::none() };
            st.typed.clear();
            return save_setting(s, SettingsChange { limits: Some(l), ..Default::default() });
        }
        Msg::Revoke(id) => {
            let name = st.tokens.iter().flatten().find(|t| t.id == id).map(|t| t.name.clone()).unwrap_or_default();
            return confirm::ask(
                format!("Revoke {name}?"),
                "It's signed out. If it's this computer, you'll need to sign in again.",
                "Revoke",
                m(Msg::RevokeSure(id)),
            );
        }
        Msg::RevokeSure(id) => {
            if let Some(l) = &mut st.tokens {
                l.retain(|t| t.id != id);
            }
            return s.call(
                move |api| async move { api.delete(&format!("/tokens/{id}")).await },
                |r| r.err().map(failed).unwrap_or(Message::Nothing),
            );
        }
        Msg::Lan(true) => {
            return s.call(
                |api| async move { api.get::<Me>("/auth/me").await },
                |r| match r {
                    Ok(me) => m(Msg::LanAfter(me.setup_done)),
                    Err(e) => failed(e),
                },
            );
        }
        Msg::LanAfter(false) => {
            return confirm::ask(
                "Set a password first?",
                "Other devices sign in with a password and an authenticator code.",
                "Set a password",
                m(Msg::SetPassword),
            );
        }
        Msg::LanAfter(true) => return Task::perform(local::set_lan(true), |r| m(Msg::LanSet(r))),
        Msg::Lan(false) => return Task::perform(local::set_lan(false), |r| m(Msg::LanSet(r))),
        Msg::LanSet(Ok(lan)) => st.lan = lan,
        Msg::LanSet(Err(e)) => return Task::done(Message::Toast(e)),
        Msg::SetPassword => return open_web(s, "setup"),
        Msg::OpenWeb => return open_web(s, ""),
        Msg::SignOut => {
            return confirm::ask(
                "Sign out?",
                "This computer stops getting notifications.",
                "Sign out",
                Message::SignOut,
            );
        }
    }
    Task::none()
}

fn model_choices(st: &State, current: &str, only_computer: bool) -> (Vec<Choice>, Option<Choice>) {
    let name = |id: &str| {
        st.models.iter().find(|o| o.id == id).map(|o| o.name.clone()).unwrap_or_else(|| format::model_name(id))
    };
    let mut list: Vec<Choice> = st
        .models
        .iter()
        .filter(|o| !only_computer || o.computer_use)
        .map(|o| Choice { id: o.id.clone(), name: o.name.clone() })
        .collect();
    let cur = Choice { id: current.to_string(), name: name(current) };
    // One set on the web, newer than this app or gone still needs its row.
    if !list.contains(&cur) {
        list.push(cur.clone());
    }
    (list, Some(cur))
}

fn effort_name(e: &str) -> String {
    match e {
        "xhigh" => "Extra high".into(),
        e => {
            let mut c = e.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
        }
    }
}

fn hour_row<'a>(name: &'a str, h: i64, on: impl Fn(Hour) -> Message + 'a) -> Element<'a, Message> {
    picker(name, hours(), Some(Hour(h)), on)
}

/// A dollar amount, the unit inside its field as on the web.
fn money<'a>(name: &'a str, k: Limit, shown: String) -> Element<'a, Message> {
    let field = container(
        row![
            text("$").size(FS_MD).style(tone(|c| c.muted)),
            text_input("", &shown)
                .on_input(move |t| m(Msg::Typed(k, t)))
                .on_submit(m(Msg::SaveLimits))
                .size(FS_MD)
                .padding(0)
                .align_x(Alignment::End)
                .width(84)
                .style(theme::bare_input)
        ]
        .spacing(SP_XS)
        .align_y(Alignment::Center),
    )
    .center_y(H)
    .padding([0.0, SP_MD])
    .style(theme::affix);
    row![text(name).size(FS_LG).width(Length::Fill), field].align_y(Alignment::Center).into()
}

/// A row that opens what's under it, with a chevron that turns.
fn disclosure<'a>(name: &'a str, open: bool, on: Message) -> Element<'a, Message> {
    let chevron = icons::icon(if open { Icon::Down } else { Icon::Chevron }, 18.0, icons::text_2);
    button(row![chevron, text(name).size(FS_MD).style(tone(|c| c.text_2))].spacing(SP).align_y(Alignment::Center))
        .padding([SP_XS, 0.0])
        .style(theme::bare(false))
        .on_press(on)
        .into()
}

pub fn view<'a>(app: &'a App, s: &'a Session) -> Element<'a, Message> {
    let st = &s.pages.settings;
    let mut col = column![].spacing(SP_PAGE);
    if let Some(e) = &st.error {
        col = col.push(error(e.as_str()));
    }
    let Some(a) = &s.settings else { return page(col) };
    let desktop = s.plugin_on("desktop");

    let expert = a.expert_model.clone().unwrap_or_default();
    let mut models = Vec::new();
    if let Some(cur) = &a.chat_model {
        let (mut list, sel) = model_choices(st, cur, false);
        // A model the brain no longer lists still has its name.
        let expert_name = list
            .iter()
            .find(|c| c.id == expert)
            .map(|c| c.name.clone())
            .or_else(|| (!expert.is_empty()).then(|| format::model_name(&expert)));
        if let Some(en) = expert_name {
            for c in list.iter_mut().filter(|c| c.id != expert) {
                c.name = format!("{}, asks {en} for hard parts", c.name);
            }
        }
        let sel = sel.and_then(|c| list.iter().find(|x| x.id == c.id).cloned());
        models.push(picker("Chat", list, sel, |c| m(Msg::Model(Role::Chat, c))));
    }
    let efforts: Vec<Choice> = CHAT_EFFORTS
        .iter()
        .map(|e| e.to_string())
        .chain(a.chat_effort.clone().filter(|e| !CHAT_EFFORTS.contains(&e.as_str())))
        .map(|e| Choice { name: effort_name(&e), id: e })
        .collect();
    let effort = a.chat_effort.as_ref().and_then(|e| efforts.iter().find(|c| &c.id == e).cloned());
    models.push(picker("Chat effort", efforts, effort, |c| m(Msg::Effort(c))));
    for (name, role, cur, computer) in [
        ("Background tasks", Role::Task, &a.task_model, false),
        ("Desktop tasks", Role::Desktop, &a.desktop_model, true),
        ("Quick jobs", Role::Small, &a.small_model, false),
        ("Hard parts", Role::Expert, &a.expert_model, false),
    ] {
        let Some(cur) = cur else { continue };
        if role == Role::Desktop && !desktop {
            continue;
        }
        let (list, sel) = model_choices(st, cur, computer);
        models.push(picker(name, list, sel, move |c| m(Msg::Model(role, c))));
    }
    // Only where a failed desktop task has a better model to go to.
    if desktop
        && a.desktop_model.as_deref() != Some(expert.as_str())
        && let Some(on) = a.desktop_escalate
        && let Some(e) = st.models.iter().find(|o| o.id == expert && o.computer_use)
    {
        models.push(switch_row(
            format!("Try desktop tasks again on {} when they fail", e.name),
            None,
            on,
            Some(|v| m(Msg::Escalate(v))),
        ));
    }
    col = col.push(group("Models", models));

    let mut routines = Vec::new();
    if let Some(h) = a.todo_hour {
        routines.push(hour_row("To-do reminder each morning at", h, |h| {
            m(Msg::Change(SettingsChange { todo_hour: Some(h.0), ..Default::default() }))
        }));
    }
    if let Some(t) = a.memory_tidy {
        routines.push(switch_row(
            "Propose a memory tidy-up weekly",
            None,
            t,
            Some(|on| m(Msg::Change(SettingsChange { memory_tidy: Some(on), ..Default::default() }))),
        ));
    }
    if !routines.is_empty() {
        col = col.push(group("Routines", routines));
    }

    if let Some(saved) = &a.limits {
        let mut lim = Vec::new();
        let shown = |k: Limit, v: f64| {
            st.typed.iter().find(|(x, _)| *x == k).map(|(_, t)| t.clone()).unwrap_or(format::amount_text(v))
        };
        for (i, (name, k)) in [
            ("Per day", Limit::Daily),
            ("Per month", Limit::Monthly),
            ("Per task", Limit::Task),
            ("Per research task", Limit::Research),
            ("Boxes per day", Limit::Boxes),
            ("Kept for alerts", Limit::Alerts),
        ]
        .into_iter()
        .enumerate()
        {
            if i == 2 {
                lim.push(disclosure("More limits", st.more_limits, m(Msg::MoreLimits(!st.more_limits))));
                if !st.more_limits {
                    break;
                }
            }
            let Some(v) = limit_of(saved, k) else { continue };
            lim.push(money(name, k, shown(k, v)));
        }
        if !st.typed.is_empty() {
            let typed = typed_limits(st, saved);
            let can_save = typed.as_ref().is_some_and(Limits::valid);
            lim.push(
                row![
                    small(if can_save { "Not saved yet." } else { "That's not an amount in dollars." })
                        .width(Length::Fill),
                    btn_sm("Save", theme::primary, can_save.then_some(m(Msg::SaveLimits)))
                ]
                .align_y(Alignment::Center)
                .into(),
            );
        }
        col = col.push(group("Spending", lim));
    }

    if let Some(on) = a.review_changes {
        col = col.push(group(
            "Safety",
            vec![switch_row(
                "Let a safety review allow safe changes without asking you",
                None,
                on,
                Some(|v| m(Msg::Review(v))),
            )],
        ));
    }

    let mut account = vec![
        row![
            text("Signed in to").size(FS_LG).width(Length::Fill),
            text(s.api.server.as_str()).size(FS_MD).style(tone(|c| c.muted))
        ]
        .align_y(Alignment::Center)
        .into(),
    ];
    if let Some(l) = &st.tokens {
        for t in l {
            let used = match &t.last_used_at {
                Some(u) => format!("Last used {}", format::stamp(u)),
                None => "Never used".into(),
            };
            account.push(
                row![
                    text(t.name.as_str()).size(FS_LG).width(Length::Fill),
                    text(used).size(FS_MD).style(tone(|c| c.muted)),
                    btn_sm("Revoke", theme::outlined, Some(m(Msg::Revoke(t.id))))
                ]
                .spacing(SP_LG)
                .align_y(Alignment::Center)
                .into(),
            );
        }
    }
    account.push(
        row![
            text("Sign out").size(FS_LG).width(Length::Fill),
            btn_sm("Sign out", theme::outlined, Some(m(Msg::SignOut)))
        ]
        .align_y(Alignment::Center)
        .into(),
    );
    col = col.push(group("Account", account));

    if s.local {
        let mut here =
            vec![switch_row("Reach it from other devices", None, st.lan.is_some(), Some(|v| m(Msg::Lan(v))))];
        if let Some(url) = &st.lan {
            here.push(
                row![
                    text("Address").size(FS_LG).width(Length::Fill),
                    text(url.as_str()).size(FS_MD).style(tone(|c| c.muted))
                ]
                .align_y(Alignment::Center)
                .into(),
            );
        }
        here.push(
            row![
                text("Web app").size(FS_LG).width(Length::Fill),
                btn_sm("Open", theme::outlined, Some(m(Msg::OpenWeb)))
            ]
            .align_y(Alignment::Center)
            .into(),
        );
        col = col.push(group("Hatbot on this computer", here));
    }

    let chosen = match app.config.theme.as_str() {
        t @ ("light" | "dark") => t,
        _ => "system",
    };
    col = col.push(group(
        "Appearance",
        vec![
            row![
                text("Theme").size(FS_LG).width(Length::Fill),
                segmented(&[("System", "system"), ("Light", "light"), ("Dark", "dark")], chosen, |t| {
                    Message::Appearance(t.to_string())
                })
            ]
            .align_y(Alignment::Center)
            .into(),
        ],
    ));

    col = col
        .push(group("System", vec![switch_row("Pause all activity", None, s.store.paused, Some(Message::SetPaused))]));
    page(col)
}
