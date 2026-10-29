// Search: messages, tasks, memory and automations, as the brain finds them.
use iced::widget::{column, rich_text, span, text};
use iced::{Element, Font, Task};

use super::Msg as PageMsg;
use crate::core::api::query;
use crate::core::format;
use crate::core::models::*;
use crate::ui::app::{Message, Route, Session};
use crate::ui::chat;
use crate::ui::theme::{self, FS_TEXT, SP_LG, SP_XS};
use crate::ui::widgets::{error, input, list_row, page, section, small, tiny};

#[derive(Debug, Clone)]
pub enum Msg {
    Query(String),
    Run(u64),
    Found(u64, Result<SearchResults, String>),
    Routine(RoutineKind, i64),
}

#[derive(Default)]
pub struct State {
    query: String,
    asked: u64,
    results: Option<SearchResults>,
    error: Option<String>,
}

fn m(msg: Msg) -> Message {
    Message::Page(PageMsg::Search(msg))
}

pub fn opened(_: &mut Session) -> Task<Message> {
    iced::widget::operation::focus(field_id())
}

fn field_id() -> iced::widget::Id {
    iced::widget::Id::new("search")
}

pub fn update(s: &mut Session, msg: Msg) -> Task<Message> {
    let st = &mut s.pages.search;
    match msg {
        Msg::Query(q) => {
            st.query = q;
            st.asked += 1;
            if st.query.trim().chars().count() < 2 {
                st.results = None;
                return Task::none();
            }
            let asked = st.asked;
            // Waits for typing to stop, so each key doesn't ask the brain.
            return Task::perform(tokio::time::sleep(std::time::Duration::from_millis(250)), move |_| {
                m(Msg::Run(asked))
            });
        }
        Msg::Run(asked) if asked == st.asked => {
            let q = query(st.query.trim());
            return s.call(
                move |api| async move { api.get::<SearchResults>(&format!("/search?q={q}")).await },
                move |r| m(Msg::Found(asked, r.map_err(|e| e.message))),
            );
        }
        Msg::Run(_) => {}
        Msg::Found(asked, r) if asked == st.asked => match r {
            Ok(r) => {
                st.results = Some(r);
                st.error = None;
            }
            Err(e) => st.error = Some(e),
        },
        Msg::Found(..) => {}
        Msg::Routine(kind, id) => {
            s.route = Route::Schedules;
            let mut t = vec![super::schedules::opened(s)];
            if kind == RoutineKind::Schedule {
                t.push(Task::done(Message::Page(PageMsg::Schedules(super::schedules::Msg::Edit(id)))));
            }
            return Task::batch(t);
        }
    }
    Task::none()
}

fn snippet(t: &str, dark: bool) -> Element<'_, Message> {
    let hue = if dark { theme::DARK.hue } else { theme::LIGHT.hue };
    let spans: Vec<_> = format::snippet(t)
        .into_iter()
        .map(|(part, hit)| {
            let sp: iced::advanced::text::Span<'_, ()> = span(part.replace('\n', " "));
            if hit { sp.font(Font { weight: iced::font::Weight::Bold, ..theme::TEXT }).color(hue) } else { sp }
        })
        .collect();
    rich_text(spans).size(FS_TEXT).into()
}

pub fn view(s: &Session, dark: bool) -> Element<'_, Message> {
    let st = &s.pages.search;
    let mut col = column![input("Search messages, tasks and memory", &st.query, |q| m(Msg::Query(q))).id(field_id())]
        .spacing(SP_LG);
    if let Some(e) = &st.error {
        col = col.push(error(e.as_str()));
    }
    let Some(r) = &st.results else { return page(col) };
    if r.is_empty() {
        col = col.push(small("Nothing found."));
    }
    if !r.messages.is_empty() {
        let mut c = column![].spacing(2);
        for h in &r.messages {
            let who = h.bot_id.as_deref().map(|b| s.store.bot_name(Some(b))).unwrap_or_else(|| "You".into());
            c = c.push(list_row(
                column![tiny(format!("{who}, {}", format::stamp(&h.created_at))), snippet(&h.snippet, dark)]
                    .spacing(SP_XS),
                Some(Message::Chat(chat::Msg::Open(h.conversation_id))),
            ));
        }
        col = col.push(section("Messages", c));
    }
    if !r.tasks.is_empty() {
        let mut c = column![].spacing(2);
        for t in &r.tasks {
            c = c.push(list_row(text(t.title.as_str()).size(FS_TEXT), Some(Message::Go(Route::Task(t.id)))));
        }
        col = col.push(section("Tasks", c));
    }
    if !r.memory.is_empty() {
        let mut c = column![].spacing(2);
        for h in &r.memory {
            let open = super::link(&format!("memory/{}", h.path)).unwrap_or_default();
            c = c.push(list_row(
                column![tiny(h.path.as_str()), text(h.text.as_str()).size(FS_TEXT)].spacing(SP_XS),
                Some(Message::Batch(open)),
            ));
        }
        col = col.push(section("Memory", c));
    }
    if !r.routines.is_empty() {
        let mut c = column![].spacing(2);
        for h in &r.routines {
            c = c.push(list_row(text(h.name.as_str()).size(FS_TEXT), Some(m(Msg::Routine(h.kind, h.id)))));
        }
        col = col.push(section("Schedules, triggers and watchers", c));
    }
    page(col)
}
