// The first start: run Hatbot on this computer, or connect to one on a server.
use iced::widget::{Space, column, container, row, text};
use iced::{Alignment, Element, Length, Task, Theme};

use super::app::Message;
use super::icons;
use super::theme::{self, FS_2XL, FS_LG, SP, SP_LG, SP_XL};
use super::widgets::{btn, error, field, input};
use crate::core::local;

#[derive(Debug, Clone)]
pub enum Msg {
    Here,
    Server,
    Back,
    Key(String),
    Start,
    Step(String),
    Done(Result<(String, String), String>),
}

pub enum Stage {
    Choose,
    Key,
    Working(String),
    Failed(String),
}

pub struct Welcome {
    pub stage: Stage,
    /// The Anthropic API key, saved once the brain is up.
    pub key: String,
}

impl Welcome {
    pub fn new() -> Self {
        Welcome { stage: Stage::Choose, key: String::new() }
    }
}

impl Default for Welcome {
    fn default() -> Self {
        Self::new()
    }
}

fn set_up() -> impl futures::Stream<Item = Message> {
    iced::stream::channel(8, async move |out: futures::channel::mpsc::Sender<Message>| {
        let step_out = out.clone();
        let step = move |s: &str| {
            let _ = step_out.clone().try_send(Message::Welcome(Msg::Step(s.to_string())));
        };
        let done = local::set_up(step).await;
        let _ = futures::SinkExt::send(&mut out.clone(), Message::Welcome(Msg::Done(done))).await;
    })
}

/// What the app does itself: choosing a server, and what's done, go to `app::update`.
pub fn update(w: &mut Welcome, m: Msg) -> Task<Message> {
    match m {
        Msg::Here => {
            w.stage = Stage::Key;
            return iced::widget::operation::focus("welcome-key");
        }
        Msg::Back => w.stage = Stage::Choose,
        Msg::Key(k) => w.key = k,
        Msg::Start => {
            w.stage = Stage::Working("Getting ready".into());
            return Task::run(set_up(), |m| m);
        }
        Msg::Step(s) => w.stage = Stage::Working(s),
        Msg::Done(Err(e)) => w.stage = Stage::Failed(e),
        Msg::Server | Msg::Done(Ok(_)) => {}
    }
    Task::none()
}

pub fn view(w: &Welcome) -> Element<'_, Msg> {
    let title = |t| {
        row![icons::hat(36.0, false, |t: &Theme| theme::colors(t).hue), text(t).size(FS_2XL)]
            .spacing(SP + 4.0)
            .align_y(Alignment::Center)
    };
    let buttons = |back: Option<Msg>, label, on: Option<Msg>| {
        row![Space::new().width(Length::Fill)]
            .push(back.map(|b| btn("Back", theme::outlined, Some(b))))
            .push(btn(label, theme::primary, on))
            .spacing(SP)
    };
    let form = match &w.stage {
        Stage::Choose => column![
            title("Welcome to Hatbot"),
            text("Hatbot can run on this computer, or you can connect to one on a server.").size(FS_LG),
            row![
                Space::new().width(Length::Fill),
                btn("Connect to a server", theme::outlined, Some(Msg::Server)),
                btn("Run it here", theme::primary, Some(Msg::Here))
            ]
            .spacing(SP),
        ],
        Stage::Key => column![
            title("Run Hatbot here"),
            text("It downloads Hatbot and starts it whenever you log in. That takes a few minutes the first time.")
                .size(FS_LG),
            field(
                "Anthropic API key",
                input("sk-ant-…", &w.key, Msg::Key).id("welcome-key").secure(true).on_submit(Msg::Start)
            ),
            buttons(Some(Msg::Back), "Set up", Some(Msg::Start)),
        ],
        Stage::Working(step) => column![title("Setting up Hatbot"), text(format!("{step}…")).size(FS_LG)],
        Stage::Failed(e) => column![
            title("Setting up Hatbot"),
            error(e.as_str()),
            buttons(Some(Msg::Back), "Try again", Some(Msg::Start)),
        ],
    }
    .spacing(SP_LG);
    container(container(form).padding(SP_XL + 8.0).width(464).style(theme::card))
        .center(Length::Fill)
        .style(theme::page)
        .into()
}
