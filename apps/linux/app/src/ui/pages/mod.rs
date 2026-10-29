// The pages besides the chat. Each keeps its own state here and reads what's live from the store.
use iced::{Element, Subscription, Task};

use super::app::{App, Message, Route, Session};
use super::markdown;
use super::widgets;
use crate::core::models::Event;

pub mod live;
pub mod schedules;
pub mod tasks;

#[derive(Debug, Clone)]
pub enum Msg {
    Tasks(tasks::Msg),
    Live(live::Msg),
    Schedules(schedules::Msg),
    OpenBox(i64),
}

#[derive(Default)]
pub struct Pages {
    pub md: markdown::Cache,
    pub tasks: tasks::State,
    pub live: live::State,
    pub schedules: schedules::State,
}

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

pub fn view<'a>(app: &'a App, s: &'a Session) -> Element<'a, Message> {
    match &s.route {
        Route::Tasks => tasks::view_list(s),
        Route::Task(id) => tasks::view_task(s, &s.pages, *id, app.dark),
        Route::Live => live::view(s),
        Route::Schedules => schedules::view(s),
        _ => widgets::page(widgets::empty(title(s))),
    }
}

pub fn update(app: &mut App, m: Msg) -> Task<Message> {
    let Some(s) = app.session_mut() else { return Task::none() };
    let t = match m {
        Msg::Tasks(m) => tasks::update(s, m),
        Msg::Live(m) => live::update(s, m),
        Msg::Schedules(m) => schedules::update(s, m),
        Msg::OpenBox(id) => {
            super::app::open_link(&format!("{}/boxes/{id}", s.api.server));
            Task::none()
        }
    };
    keep_markdown(s);
    t
}

/// Summaries and notes that show as Markdown stay parsed.
fn keep_markdown(s: &mut Session) {
    let mut texts: Vec<String> = Vec::new();
    if let Route::Task(id) = s.route
        && let Some(summary) = s.store.tasks.get(&id).and_then(|t| t.summary.clone())
    {
        texts.push(summary);
    }
    s.pages.md.keep(texts.iter().map(String::as_str));
}

pub fn opened(s: &mut Session, r: &Route) -> Task<Message> {
    let t = match r {
        Route::Tasks => tasks::opened(s),
        Route::Task(id) => tasks::opened_task(s, *id),
        Route::Live => live::opened(s),
        Route::Schedules => schedules::opened(s),
        _ => Task::none(),
    };
    keep_markdown(s);
    t
}

pub fn reconnected(s: &mut Session) -> Task<Message> {
    match s.route {
        Route::Tasks | Route::Task(_) => tasks::reconnected(s),
        _ => Task::none(),
    }
}

/// What an event means for the pages, taken before the store applies it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Hint {
    None,
    Step(i64),
    Task,
}

pub fn event_hint(e: &Event) -> Hint {
    match e {
        Event::TaskStepAdded { step } => Hint::Step(step.task_id),
        Event::TaskUpdated { .. } => Hint::Task,
        _ => Hint::None,
    }
}

pub fn on_event(s: &mut Session, h: Hint) -> Task<Message> {
    let t = match h {
        Hint::Step(task) => tasks::on_step(s, task),
        Hint::Task | Hint::None => Task::none(),
    };
    if h != Hint::None {
        keep_markdown(s);
    }
    t
}

pub fn subscription(s: &Session) -> Subscription<Message> {
    live::subscription(s)
}
