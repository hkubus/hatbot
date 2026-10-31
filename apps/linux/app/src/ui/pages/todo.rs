// To-do: memory's to-do list, ticked off here or handed to Hatbot.
use iced::widget::{checkbox, column, row, text};
use iced::{Alignment, Element, Length, Task};
use serde_json::json;

use super::Msg as PageMsg;
use crate::core::format;
use crate::core::models::*;
use crate::ui::app::{Message, Route, Session, failed};
use crate::ui::theme::{self, FS_LG, FS_MD, H, SP, SP_LG};
use crate::ui::widgets::{btn_sm, empty_tile, error, group, input, page_narrow, tiles, tone};

#[derive(Debug, Clone)]
pub enum Msg {
    Loaded(Result<TodoList, String>),
    Item(String),
    Due(String),
    Add,
    Tick(Todo),
    Work(Todo),
}

#[derive(Default)]
pub struct State {
    list: Option<TodoList>,
    error: Option<String>,
    item: String,
    due: String,
}

fn m(msg: Msg) -> Message {
    Message::Page(PageMsg::Todo(msg))
}

pub fn opened(s: &mut Session) -> Task<Message> {
    s.call(
        |api| async move { api.get::<TodoList>("/todo").await },
        |r| match r {
            Err(e) if e.is_unauthorized() => Message::Unauthorized,
            r => m(Msg::Loaded(r.map_err(|e| e.message))),
        },
    )
}

fn changed(r: Result<TodoList, crate::core::api::ApiError>) -> Message {
    match r {
        Ok(l) => m(Msg::Loaded(Ok(l))),
        Err(e) => failed(e),
    }
}

pub fn update(s: &mut Session, msg: Msg) -> Task<Message> {
    let st = &mut s.pages.todo;
    match msg {
        Msg::Loaded(Ok(l)) => {
            st.list = Some(l);
            st.error = None;
        }
        Msg::Loaded(Err(e)) => st.error = Some(e),
        Msg::Item(v) => st.item = v,
        Msg::Due(v) => st.due = v,
        Msg::Add => {
            let item = st.item.trim().to_string();
            if item.is_empty() {
                return Task::none();
            }
            let due = if st.due.trim().is_empty() {
                None
            } else {
                match format::ymd(&st.due) {
                    Some(d) => Some(d),
                    None => return Task::done(Message::Toast("Write the date as 2026-11-02.".into())),
                }
            };
            st.item.clear();
            st.due.clear();
            // The brain takes no due date as the field left out, not as null.
            let body = match due {
                Some(d) => json!({ "item": item, "due": d }),
                None => json!({ "item": item }),
            };
            return s.call(move |api| async move { api.post::<TodoList, _>("/todo", &body).await }, changed);
        }
        Msg::Tick(t) => {
            let body = json!({ "text": t.text, "line": t.line });
            return s.call(move |api| async move { api.post::<TodoList, _>("/todo/done", &body).await }, changed);
        }
        Msg::Work(t) => {
            let body = json!({ "text": t.text, "line": t.line });
            return s.call(
                move |api| async move { api.post::<crate::core::models::Task, _>("/todo/work", &body).await },
                |r| match r {
                    Ok(_) => Message::Toast("Hatbot is on it.".into()),
                    Err(e) => failed(e),
                },
            );
        }
    }
    Task::none()
}

pub fn view(s: &Session) -> Element<'_, Message> {
    let st = &s.pages.todo;
    let mut col = column![].spacing(SP_LG);
    let can_add = !st.item.trim().is_empty();
    col = col.push(
        row![
            input("Add a to-do", &st.item, |v| m(Msg::Item(v))).on_submit(m(Msg::Add)).width(Length::Fill),
            input("Due, like 2026-11-02", &st.due, |v| m(Msg::Due(v))).on_submit(m(Msg::Add)).width(180),
            btn_sm("Add", theme::outlined, can_add.then_some(m(Msg::Add))).height(H)
        ]
        .spacing(SP)
        .align_y(Alignment::Center),
    );
    if let Some(e) = &st.error {
        col = col.push(error(e.as_str()));
    }
    let Some(list) = &st.list else { return page_narrow(col) };
    let open: Vec<&Todo> = list.items.iter().filter(|t| !t.done).collect();
    if open.is_empty() {
        col = col.push(empty_tile("Nothing to do. Add one here, or ask Hatbot in chat."));
    } else {
        let rows = open
            .into_iter()
            .map(|t| {
                let tick = {
                    let t = t.clone();
                    checkbox(false).size(18).style(theme::check).on_toggle(move |_| m(Msg::Tick(t.clone())))
                };
                let mut r = row![tick, text(t.text.as_str()).size(FS_LG).width(Length::Fill)]
                    .spacing(SP_LG)
                    .align_y(Alignment::Center);
                if let Some(d) = &t.due {
                    let (label, overdue) = format::due(d, t.at.as_deref());
                    r = r.push(text(label).size(FS_MD).style(tone(if overdue { |c| c.danger } else { |c| c.text_2 })));
                }
                r = r.push(match t.task_id {
                    Some(id) => btn_sm("Working on it", theme::plain, Some(Message::Go(Route::Task(id)))),
                    None => btn_sm("Work on it", theme::outlined, Some(m(Msg::Work(t.clone())))),
                });
                r.into()
            })
            .collect();
        col = col.push(tiles(rows));
    }
    let done: Vec<&Todo> = list.items.iter().filter(|t| t.done).rev().collect();
    if !done.is_empty() {
        let rows = done
            .into_iter()
            .map(|t| {
                row![
                    checkbox(true).size(18).style(theme::check),
                    text(t.text.as_str()).size(FS_MD).style(tone(|c| c.text_2)).width(Length::Fill),
                    text(t.done_on.as_deref().map(|on| format::due(on, None).0).unwrap_or_default())
                        .size(FS_MD)
                        .style(tone(|c| c.text_2))
                ]
                .spacing(SP_LG)
                .align_y(Alignment::Center)
                .into()
            })
            .collect();
        col = col.push(group("Done this week", rows));
    }
    page_narrow(col)
}
