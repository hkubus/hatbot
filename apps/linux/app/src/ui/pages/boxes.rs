// Boxes: the little apps Hatbot built. They run in the browser, on the web app's page for them.
use iced::widget::{column, row, text};
use iced::{Alignment, Element, Length, Task};

use super::Msg as PageMsg;
use crate::core::format;
use crate::core::models::*;
use crate::ui::app::{Message, Session, failed};
use crate::ui::confirm;
use crate::ui::theme::{self, FS_TEXT, SP, SP_MD};
use crate::ui::widgets::{btn_sm, error, list_row, page, small, tiny};

#[derive(Debug, Clone)]
pub enum Msg {
    Loaded(Result<Vec<AppBox>, String>),
    Delete(i64),
    DeleteSure(i64),
}

#[derive(Default)]
pub struct State {
    loaded: bool,
    error: Option<String>,
}

fn m(msg: Msg) -> Message {
    Message::Page(PageMsg::Boxes(msg))
}

pub fn opened(s: &mut Session) -> Task<Message> {
    s.call(
        |api| async move { api.get::<Vec<AppBox>>("/boxes").await },
        |r| match r {
            Err(e) if e.is_unauthorized() => Message::Unauthorized,
            r => m(Msg::Loaded(r.map_err(|e| e.message))),
        },
    )
}

pub fn update(s: &mut Session, msg: Msg) -> Task<Message> {
    match msg {
        Msg::Loaded(Ok(list)) => {
            s.pages.boxes.loaded = true;
            s.pages.boxes.error = None;
            s.store.boxes =
                list.into_iter().filter(|b| !s.store.deleted_boxes.contains(&b.id)).map(|b| (b.id, b)).collect();
        }
        Msg::Loaded(Err(e)) => s.pages.boxes.error = Some(e),
        Msg::Delete(id) => {
            let name = s.store.boxes.get(&id).map(|b| b.title.clone()).unwrap_or_default();
            return confirm::ask(format!("Delete {name}?"), "Its data goes too.", "Delete", m(Msg::DeleteSure(id)));
        }
        Msg::DeleteSure(id) => {
            s.store.boxes.remove(&id);
            return s.call(
                move |api| async move { api.delete(&format!("/boxes/{id}")).await },
                |r| r.err().map(failed).unwrap_or(Message::Nothing),
            );
        }
    }
    Task::none()
}

pub fn view(s: &Session) -> Element<'_, Message> {
    let st = &s.pages.boxes;
    let mut col = column![].spacing(SP);
    if let Some(e) = &st.error {
        col = col.push(error(e.as_str()));
    }
    if st.loaded && s.store.boxes.is_empty() {
        col = col.push(small("No boxes yet. Ask Hatbot for a tracker, a calculator or a planner to keep."));
    }
    let mut list: Vec<&AppBox> = s.store.boxes.values().collect();
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    for b in list {
        col = col.push(list_row(
            row![
                column![
                    text(b.title.as_str()).size(FS_TEXT),
                    tiny(format!("Version {}, {}", b.version, format::stamp(&b.updated_at)))
                ]
                .spacing(2)
                .width(Length::Fill),
                btn_sm("Delete", theme::plain, Some(m(Msg::Delete(b.id))))
            ]
            .spacing(SP_MD)
            .align_y(Alignment::Center),
            Some(Message::Page(PageMsg::OpenBox(b.id))),
        ));
    }
    page(col)
}
