// Tasks: what's running and what finished, and one task's timeline.
use iced::widget::{column, container, image, row, text, text_editor};
use iced::{Alignment, Color, Element, Length, Task};
use serde_json::json;

use super::{Msg as PageMsg, Pages};
use crate::core::format;
use crate::core::models::Task as AgentTask;
use crate::core::models::*;
use crate::core::store::PAGE;
use crate::ui::app::{Message, Route, Session, failed};
use crate::ui::chat;
use crate::ui::icons::{self, Icon};
use crate::ui::theme::{self, Colors, FS_LG, FS_MD, FS_SM, FS_XL, SP, SP_LG, SP_MD, SP_SM, SP_XL};
use crate::ui::widgets::{
    area, body, btn, btn_sm, card, empty, error, gap, labeled, list_row, page, section, segmented, small, tiny, tone,
};

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum Filter {
    #[default]
    Active,
    Done,
}

#[derive(Debug, Clone)]
pub enum Msg {
    Filter(Filter),
    Listed(Filter, bool, Result<Vec<AgentTask>, String>),
    More,
    Loaded(i64, Result<TaskWithSteps, String>),
    Missing(i64),
    Cancel(i64),
    Rerun(i64),
    RerunEdit(text_editor::Action),
    RerunGo(i64),
    RerunCancel,
    Started(Result<AgentTask, String>),
    Details,
}

#[derive(Default)]
pub struct State {
    filter: Filter,
    active_loaded: bool,
    finished: Option<Vec<i64>>,
    more: bool,
    error: Option<String>,
    missing: Option<i64>,
    rerun: Option<text_editor::Content>,
    details: bool,
}

fn m(msg: Msg) -> Message {
    Message::Page(PageMsg::Tasks(msg))
}

pub fn opened(s: &mut Session) -> Task<Message> {
    list(s, s.pages.tasks.filter, None)
}

fn list(s: &Session, f: Filter, before: Option<i64>) -> Task<Message> {
    let status = match f {
        Filter::Active => "active",
        Filter::Done => "done",
    };
    let path =
        format!("/tasks?status={status}&view=card{}", before.map(|b| format!("&before={b}")).unwrap_or_default());
    let more = before.is_some();
    s.call(
        move |api| async move { api.get::<Vec<AgentTask>>(&path).await },
        move |r| match r {
            Err(e) if e.is_unauthorized() => Message::Unauthorized,
            r => m(Msg::Listed(f, more, r.map_err(|e| e.message))),
        },
    )
}

pub fn opened_task(s: &mut Session, id: i64) -> Task<Message> {
    s.pages.tasks.rerun = None;
    s.pages.tasks.details = false;
    load(s, id)
}

fn load(s: &Session, id: i64) -> Task<Message> {
    s.call(
        move |api| async move { api.get::<TaskWithSteps>(&format!("/tasks/{id}")).await },
        move |r| match r {
            Err(e) if e.status == 404 => m(Msg::Missing(id)),
            Err(e) if e.is_unauthorized() => Message::Unauthorized,
            r => m(Msg::Loaded(id, r.map_err(|e| e.message))),
        },
    )
}

/// After time away: what's open, as it is now.
pub fn reconnected(s: &mut Session) -> Task<Message> {
    match s.route {
        Route::Tasks => opened(s),
        Route::Task(id) => load(s, id),
        _ => Task::none(),
    }
}

pub fn update(s: &mut Session, msg: Msg) -> Task<Message> {
    let st = &mut s.pages.tasks;
    match msg {
        Msg::Filter(f) => {
            st.filter = f;
            st.error = None;
            return list(s, f, None);
        }
        Msg::Listed(f, more, Ok(tasks)) => {
            let ids: Vec<i64> = tasks.iter().map(|t| t.id).collect();
            let full = ids.len() == PAGE;
            for t in tasks {
                s.store.take_task(t);
            }
            let st = &mut s.pages.tasks;
            st.error = None;
            match f {
                Filter::Active => st.active_loaded = true,
                Filter::Done => {
                    let list =
                        if more { st.finished.get_or_insert_with(Vec::new) } else { st.finished.insert(Vec::new()) };
                    for id in ids {
                        if !list.contains(&id) {
                            list.push(id);
                        }
                    }
                    st.more = full;
                }
            }
        }
        Msg::Listed(_, _, Err(e)) => st.error = Some(e),
        Msg::More => {
            if let Some(last) = st.finished.as_ref().and_then(|l| l.last()).copied() {
                st.more = false;
                return list(s, Filter::Done, Some(last));
            }
        }
        Msg::Loaded(id, Ok(res)) => {
            s.store.tasks.insert(id, res.task);
            s.store.steps.insert(id, res.steps);
            if s.pages.tasks.missing == Some(id) {
                s.pages.tasks.missing = None;
            }
            return screens(s, id);
        }
        Msg::Loaded(_, Err(e)) => return Task::done(Message::Toast(e)),
        Msg::Missing(id) => st.missing = Some(id),
        Msg::Cancel(id) => {
            return s.call(
                move |api| async move { api.post_empty(&format!("/tasks/{id}/cancel")).await },
                |r| r.map(|_| Message::Nothing).unwrap_or_else(failed),
            );
        }
        Msg::Rerun(id) => {
            let goal = s.store.tasks.get(&id).and_then(|t| t.goal.clone()).unwrap_or_default();
            s.pages.tasks.rerun = Some(text_editor::Content::with_text(&goal));
        }
        Msg::RerunEdit(a) => {
            if let Some(c) = &mut st.rerun {
                c.perform(a);
            }
        }
        Msg::RerunCancel => st.rerun = None,
        Msg::RerunGo(id) => {
            let Some(c) = st.rerun.take() else { return Task::none() };
            let goal = c.text().trim().to_string();
            let same = s.store.tasks.get(&id).and_then(|t| t.goal.as_deref()) == Some(goal.as_str());
            let body = json!({ "goal": if same { None } else { Some(goal) } });
            return s.call(
                move |api| async move { api.post::<AgentTask, _>(&format!("/tasks/{id}/rerun"), &body).await },
                |r| m(Msg::Started(r.map_err(|e| e.message))),
            );
        }
        Msg::Started(Ok(t)) => {
            let id = t.id;
            s.store.take_task(t);
            return Task::done(Message::Go(Route::Task(id)));
        }
        Msg::Started(Err(e)) => return Task::done(Message::Toast(e)),
        Msg::Details => st.details = !st.details,
    }
    Task::none()
}

/// A step that's new on the open task brings its screenshot.
pub fn on_step(s: &mut Session, task: i64) -> Task<Message> {
    if s.route == Route::Task(task) { screens(s, task) } else { Task::none() }
}

fn screens(s: &mut Session, id: i64) -> Task<Message> {
    let paths: Vec<String> = s
        .store
        .steps
        .get(&id)
        .map(|l| {
            l.iter().filter(|st| st.screenshot.is_some()).map(|st| format!("/tasks/{id}/screens/{}", st.id)).collect()
        })
        .unwrap_or_default();
    let mut t = Vec::new();
    for p in paths.into_iter().rev().take(20) {
        t.push(chat::fetch_image(s, p));
    }
    Task::batch(t)
}

pub fn status_tone(st: TaskStatus) -> fn(&Colors) -> Color {
    match st {
        TaskStatus::WaitingApproval | TaskStatus::WaitingTakeover | TaskStatus::WaitingAnswer => |c| c.hue,
        TaskStatus::Running => |c| c.text_2,
        TaskStatus::Done => |c| c.success,
        TaskStatus::Failed => |c| c.danger,
        TaskStatus::Queued | TaskStatus::Cancelled => |c| c.muted,
    }
}

pub fn view_list(s: &Session) -> Element<'_, Message> {
    let st = &s.pages.tasks;
    let mut col =
        column![segmented(&[("Active", Filter::Active), ("Finished", Filter::Done)], st.filter, |f| m(Msg::Filter(f)))]
            .spacing(SP_LG);
    if let Some(r) = s.store.desktop.as_ref().and_then(|d| d.request.as_ref()) {
        col = col.push(
            container(
                row![
                    icons::filled(Icon::Hand, 20.0, icons::hue),
                    text(format!("Hatbot needs you: {}", r.reason)).size(FS_MD).width(Length::Fill),
                    btn_sm("Open Live", theme::primary, Some(Message::Go(Route::Live)))
                ]
                .spacing(SP_MD)
                .align_y(Alignment::Center),
            )
            .padding(SP_LG)
            .width(Length::Fill)
            .style(theme::attention),
        );
    }
    for a in s.store.pending_approvals() {
        col = col.push(container(chat::approval(s, a)).padding(SP_LG).width(Length::Fill).style(theme::attention));
    }
    for q in s.store.pending_questions() {
        col = col.push(container(chat::question(s, q)).padding(SP_LG).width(Length::Fill).style(theme::attention));
    }
    if let Some(e) = &st.error {
        col = col.push(error(e.as_str()));
    }
    let shown: Vec<&AgentTask> = {
        let mut v: Vec<&AgentTask> = match st.filter {
            Filter::Active => s.store.tasks.values().filter(|t| t.status.is_active()).collect(),
            Filter::Done => {
                let ids = st.finished.as_deref().unwrap_or(&[]);
                s.store.tasks.values().filter(|t| !t.status.is_active() && ids.contains(&t.id)).collect()
            }
        };
        v.sort_by_key(|t| std::cmp::Reverse(t.id));
        v
    };
    let loaded = match st.filter {
        Filter::Active => st.active_loaded,
        Filter::Done => st.finished.is_some(),
    };
    if shown.is_empty() && loaded && st.error.is_none() {
        col = col.push(empty(if st.filter == Filter::Active { "Nothing running." } else { "No tasks yet." }));
    }
    let mut rows = column![].spacing(2);
    for t in shown {
        rows = rows.push(list_row(
            column![
                text(t.title.as_str()).size(FS_LG),
                row![
                    text(format::status_label(t.status)).size(FS_SM).style(tone(status_tone(t.status))),
                    tiny(format::stamp(t.started_at.as_deref().unwrap_or(&t.created_at))),
                    tiny(s.store.bot_name(Some(&t.bot_id))),
                ]
                .spacing(SP)
            ]
            .spacing(2),
            Some(Message::Go(Route::Task(t.id))),
        ));
    }
    col = col.push(rows);
    if st.filter == Filter::Done && st.more {
        col = col.push(btn("Show more", theme::outlined, Some(m(Msg::More))));
    }
    page(col)
}

pub fn view_task<'a>(s: &'a Session, pages: &'a Pages, id: i64, dark: bool) -> Element<'a, Message> {
    let st = &pages.tasks;
    let Some(t) = s.store.tasks.get(&id) else {
        return page(empty(if st.missing == Some(id) { "This task doesn't exist." } else { "" }));
    };
    let mut col = column![].spacing(SP_XL);
    for a in s.store.approvals.values().filter(|a| a.task_id == Some(id) && a.status.is_open()) {
        col = col.push(container(chat::approval(s, a)).padding(SP_LG).width(Length::Fill).style(theme::attention));
    }
    for q in s.store.pending_questions().into_iter().filter(|q| q.task_id == id) {
        col = col.push(container(chat::question(s, q)).padding(SP_LG).width(Length::Fill).style(theme::attention));
    }

    let mut actions = row![].spacing(SP);
    if t.lane == "screen" && t.status.is_active() {
        actions = actions.push(btn_sm("Watch", theme::outlined, Some(Message::Go(Route::Live))));
    }
    if t.status.is_active() {
        actions = actions.push(btn_sm("Cancel task", theme::danger, Some(m(Msg::Cancel(id)))));
    } else if t.lane == "background" && t.parent_id.is_none() && t.goal.is_some() && st.rerun.is_none() {
        actions = actions.push(btn_sm("Run again", theme::outlined, Some(m(Msg::Rerun(id)))));
    }
    let mut head = column![
        row![
            column![
                text(t.title.as_str()).size(FS_XL),
                text(format::status_label(t.status)).size(FS_MD).style(tone(status_tone(t.status)))
            ]
            .spacing(SP_SM)
            .width(Length::Fill),
            actions
        ]
        .spacing(SP_LG)
    ]
    .spacing(SP_MD);
    if t.status.is_active() {
        head = head.push(small(format::task_line(t, s.store.task_progress.get(&id).map(String::as_str))));
    } else if let Some(summary) = &t.summary {
        head = head.push(match pages.md.get(summary) {
            Some(c) => crate::ui::markdown::view(c, dark, Message::Link),
            None => body(summary.as_str()).into(),
        });
    }
    if let Some(goal) = &st.rerun {
        head = head.push(
            column![
                area(goal, "Goal", |a| m(Msg::RerunEdit(a))),
                row![
                    btn_sm("Cancel", theme::plain, Some(m(Msg::RerunCancel))),
                    btn_sm("Run", theme::primary, (!goal.text().trim().is_empty()).then_some(m(Msg::RerunGo(id))))
                ]
                .spacing(SP)
            ]
            .spacing(SP),
        );
    }
    if t.is_full() {
        head =
            head.push(btn_sm(if st.details { "Hide details" } else { "Details" }, theme::plain, Some(m(Msg::Details))));
        if st.details {
            head = head.push(details(s, t));
        }
    }
    col = col.push(card(head));

    let mut steps = column![].spacing(SP_LG);
    match s.store.steps.get(&id) {
        Some(list) => {
            let list = latest_note_only(list);
            if list.is_empty() {
                steps = steps.push(small(if t.status.is_active() { "Hasn't started yet." } else { "No steps." }));
            }
            for step in list {
                steps = steps.push(step_row(s, step));
            }
        }
        None => steps = steps.push(gap(0.0)),
    }
    col = col.push(section("Timeline", steps));
    page(col)
}

fn details<'a>(s: &'a Session, t: &'a AgentTask) -> Element<'a, Message> {
    let from: Element<'a, Message> = match t.parent_id {
        Some(p) => btn_sm(format!("Task #{p}"), theme::link, Some(Message::Go(Route::Task(p)))).into(),
        None => body(if t.origin == "chat" { "Chat".to_string() } else { t.source.clone().unwrap_or_default() }).into(),
    };
    let trust = if t.injection_suspected {
        "Possible prompt injection"
    } else if !t.tainted {
        "Trusted sources only"
    } else if t.lane == "screen" {
        "Read web pages"
    } else {
        "Read untrusted content"
    };
    let mut col =
        column![labeled("From", from), labeled("Goal", body(t.goal.clone().unwrap_or_default())),].spacing(SP_MD);
    if let Some(c) = t.success_criteria.as_deref().filter(|c| !c.is_empty()) {
        col = col.push(labeled("Done when", body(c)));
    }
    col = col
        .push(labeled("Started", body(t.started_at.as_deref().map(format::stamp).unwrap_or_else(|| "–".into()))))
        .push(labeled("Model", body(format::model_name(&t.model))))
        .push(labeled("Bot", body(s.store.bot_name(Some(&t.bot_id)))))
        .push(labeled("Trust", body(trust)));
    if let Some(by) = &t.tainted_by {
        col = col.push(labeled("Tainted by", body(by.as_str())));
    }
    col = col.push(labeled("Cost", body(format::money(t.cost_usd.unwrap_or(0.0)))));
    if let Some(p) = &t.report_path {
        col = col.push(labeled("Report", body(p.as_str())));
    }
    if let Some(p) = &t.payload {
        col = col.push(labeled(
            "Event",
            container(text(p.as_str()).size(FS_SM).font(theme::CODE))
                .padding(SP_MD)
                .width(Length::Fill)
                .style(theme::code_block),
        ));
    }
    col.into()
}

fn step_icon(step: &TaskStep) -> Icon {
    match step.kind {
        StepKind::Action if step.name.starts_with("memory_") => Icon::Book,
        StepKind::Action if step.name == "search_history" => Icon::Chat,
        StepKind::Note => Icon::Chat,
        StepKind::Action => Icon::Pointer,
        StepKind::Screenshot | StepKind::Task => Icon::Monitor,
        StepKind::Page => Icon::Globe,
        StepKind::Approval => Icon::Shield,
        StepKind::Takeover => Icon::Hand,
        StepKind::Error => Icon::Alert,
    }
}

fn step_row<'a>(s: &'a Session, step: &'a TaskStep) -> Element<'a, Message> {
    let lit = matches!(step.kind, StepKind::Approval | StepKind::Takeover);
    let glyph = icons::icon(step_icon(step), 18.0, if lit { icons::hue } else { icons::muted });
    let mut col = column![].spacing(SP_SM).width(Length::Fill);
    let task_link = (step.kind == StepKind::Task)
        .then(|| step.url.as_deref().and_then(|u| u.rsplit('/').next()).and_then(|n| n.parse::<i64>().ok()))
        .flatten();
    col = match task_link {
        Some(id) => col.push(btn_sm(step.name.as_str(), theme::link, Some(Message::Go(Route::Task(id))))),
        None => col.push(body(if step.detail.is_empty() || step.kind == StepKind::Note {
            step.name.as_str()
        } else {
            step.detail.as_str()
        })),
    };
    if step.kind == StepKind::Note && !step.detail.is_empty() {
        col = col.push(small(step.detail.as_str()));
    }
    if step.kind == StepKind::Page
        && let Some(url) = &step.url
    {
        let host = url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url).to_string();
        col = col.push(btn_sm(host, theme::link, Some(Message::Link(url.clone()))));
    }
    if step.screenshot.is_some()
        && let Some(h) = chat::image_of(s, &format!("/tasks/{}/screens/{}", step.task_id, step.id))
    {
        col = col.push(container(image(h.clone()).width(Length::Fill)).max_height(360).style(theme::screen));
    }
    col = col.push(tiny(format::time_text(&step.created_at)));
    row![container(glyph).padding([3, 0]), col].spacing(SP_MD).into()
}
