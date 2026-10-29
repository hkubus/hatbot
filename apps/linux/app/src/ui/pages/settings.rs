// Settings: the models, spending limits, the safety review, and what's signed in.
use iced::widget::{column, row, text};
use iced::{Alignment, Element, Length, Task};

use super::Msg as PageMsg;
use super::schedules::save_setting;
use crate::core::format;
use crate::core::models::*;
use crate::ui::app::{Message, Session, failed};
use crate::ui::confirm;
use crate::ui::theme::{self, FS_TEXT, SP, SP_MD, SP_XL};
use crate::ui::widgets::{
    Choice, btn, btn_sm, card, error, input, labeled, page, picker, section, small, switch_row, tiny,
};

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
    Revoke(i64),
    RevokeSure(i64),
    SignOut,
}

#[derive(Default)]
pub struct State {
    models: Vec<ModelOption>,
    tokens: Option<Vec<ApiToken>>,
    error: Option<String>,
    /// Limits as typed, until saved.
    typed: Vec<(Limit, String)>,
}

fn m(msg: Msg) -> Message {
    Message::Page(PageMsg::Settings(msg))
}

pub fn opened(s: &mut Session) -> Task<Message> {
    s.pages.settings.typed.clear();
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

pub fn view(s: &Session) -> Element<'_, Message> {
    let st = &s.pages.settings;
    let mut col = column![].spacing(SP_XL);
    if let Some(e) = &st.error {
        col = col.push(error(e.as_str()));
    }
    col = col.push(card(switch_row("Pause all activity", None, s.store.paused, Some(Message::SetPaused))));
    let Some(a) = &s.settings else { return page(col) };

    let expert = a.expert_model.clone().unwrap_or_default();
    let mut models = column![].spacing(SP_MD);
    if let Some(cur) = &a.chat_model {
        let (mut list, sel) = model_choices(st, cur, false);
        let expert_name = list.iter().find(|c| c.id == expert).map(|c| c.name.clone());
        if let Some(en) = expert_name {
            for c in list.iter_mut().filter(|c| c.id != expert) {
                c.name = format!("{}, asks {en} for hard parts", c.name);
            }
        }
        let sel = sel.and_then(|c| list.iter().find(|x| x.id == c.id).cloned());
        models = models.push(picker("Chat", list, sel, |c| m(Msg::Model(Role::Chat, c))));
    }
    let efforts: Vec<Choice> = CHAT_EFFORTS
        .iter()
        .map(|e| e.to_string())
        .chain(a.chat_effort.clone().filter(|e| !CHAT_EFFORTS.contains(&e.as_str())))
        .map(|e| Choice { name: effort_name(&e), id: e })
        .collect();
    let effort = a.chat_effort.as_ref().and_then(|e| efforts.iter().find(|c| &c.id == e).cloned());
    models = models.push(picker("Chat effort", efforts, effort, |c| m(Msg::Effort(c))));
    for (name, role, cur, computer) in [
        ("Background tasks", Role::Task, &a.task_model, false),
        ("Desktop tasks", Role::Desktop, &a.desktop_model, true),
        ("Quick jobs", Role::Small, &a.small_model, false),
        ("Hard parts", Role::Expert, &a.expert_model, false),
    ] {
        let Some(cur) = cur else { continue };
        let (list, sel) = model_choices(st, cur, computer);
        models = models.push(picker(name, list, sel, move |c| m(Msg::Model(role, c))));
        if role == Role::Desktop
            && *cur != expert
            && let Some(on) = a.desktop_escalate
        {
            let en = st
                .models
                .iter()
                .find(|o| o.id == expert)
                .map(|o| o.name.clone())
                .unwrap_or(format::model_name(&expert));
            models = models.push(switch_row(
                format!("Try desktop tasks again on {en} when they fail"),
                None,
                on,
                Some(|v| m(Msg::Escalate(v))),
            ));
        }
    }
    col = col.push(section("Models", card(models)));

    if let Some(saved) = &a.limits {
        let mut lim = column![].spacing(SP_MD);
        for (name, k) in [
            ("Per day", Limit::Daily),
            ("Per month", Limit::Monthly),
            ("Per task", Limit::Task),
            ("Per research task", Limit::Research),
            ("Boxes per day", Limit::Boxes),
            ("Kept for alerts", Limit::Alerts),
        ] {
            let Some(v) = limit_of(saved, k) else { continue };
            let shown =
                st.typed.iter().find(|(x, _)| *x == k).map(|(_, t)| t.clone()).unwrap_or(format::amount_text(v));
            lim = lim.push(
                row![
                    text(name).size(FS_TEXT).width(Length::Fill),
                    text("$").size(FS_TEXT),
                    input("", &shown, move |t| m(Msg::Typed(k, t))).on_submit(m(Msg::SaveLimits)).width(120)
                ]
                .spacing(SP)
                .align_y(Alignment::Center),
            );
        }
        let typed = typed_limits(st, saved);
        let can_save = !st.typed.is_empty() && typed.as_ref().is_some_and(Limits::valid);
        lim = lim.push(
            row![
                small("In dollars. Hatbot stops before going past one.").width(Length::Fill),
                btn_sm("Save", theme::primary, can_save.then_some(m(Msg::SaveLimits)))
            ]
            .align_y(Alignment::Center),
        );
        col = col.push(section("Spending limits", card(lim)));
    }

    if let Some(on) = a.review_changes {
        col = col.push(section(
            "Safety",
            card(switch_row(
                "Let a safety review allow safe changes without asking you",
                None,
                on,
                Some(|v| m(Msg::Review(v))),
            )),
        ));
    }

    let mut account = column![labeled("Signed in to", text(s.api.server.as_str()).size(FS_TEXT))].spacing(SP_MD);
    match &st.tokens {
        Some(l) if l.is_empty() => account = account.push(small("Nothing is signed in with a token.")),
        Some(l) => {
            for t in l {
                let added = format!("Added {}", format::stamp(&t.created_at));
                let line = match &t.last_used_at {
                    Some(u) => format!("{added}, last used {}", format::stamp(u)),
                    None => format!("{added}, never used"),
                };
                account = account.push(
                    row![
                        column![text(t.name.as_str()).size(FS_TEXT), tiny(line)].spacing(2).width(Length::Fill),
                        btn_sm("Revoke", theme::plain, Some(m(Msg::Revoke(t.id))))
                    ]
                    .align_y(Alignment::Center),
                );
            }
        }
        None => {}
    }
    account = account.push(row![btn("Sign out", theme::outlined, Some(m(Msg::SignOut)))]);
    col = col.push(section("Devices and tokens", card(account)));
    page(col)
}
