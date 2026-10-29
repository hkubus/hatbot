// The pages besides the chat.
use iced::{Element, Subscription, Task};

use super::app::{App, Message, Route, Session};
use super::widgets;
use crate::core::models::Event;

#[derive(Debug, Clone)]
pub enum Msg {
    OpenBox(i64),
}

#[derive(Default)]
pub struct Pages {}

pub fn title(s: &Session) -> String {
    match s.route {
        Route::Tasks | Route::Task(_) => "Tasks",
        Route::Live => "Live",
        Route::Schedules => "Automations",
        Route::Memory => "Memory",
        Route::Todo => "To-do",
        Route::Boxes => "Boxes",
        Route::Search => "Search",
        Route::Settings => "Settings",
        Route::Spend => "Spend",
        Route::Computer => "This computer",
        Route::NewBot => "New bot",
        Route::Bot(_) | Route::Group(_) | Route::Chat | Route::Threads => "",
    }
    .into()
}

pub fn view<'a>(_app: &'a App, s: &'a Session) -> Element<'a, Message> {
    widgets::page(widgets::empty(title(s)))
}

pub fn update(_app: &mut App, _m: Msg) -> Task<Message> {
    Task::none()
}

pub fn opened(_s: &mut Session, _r: &Route) -> Task<Message> {
    Task::none()
}

pub fn reconnected(_s: &Session) -> Task<Message> {
    Task::none()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Hint {
    None,
}

pub fn event_hint(_e: &Event) -> Hint {
    Hint::None
}

pub fn on_event(_s: &mut Session, _h: Hint) -> Task<Message> {
    Task::none()
}

pub fn subscription(_s: &Session) -> Subscription<Message> {
    Subscription::none()
}
