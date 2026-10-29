// Signing in: the brain's address, the password and an authenticator code.
use iced::widget::{column, container, row, text};
use iced::{Alignment, Element, Length, Task, Theme};

use super::app::Message;
use super::icons;
use super::theme::{self, FS_2XL, SP, SP_LG, SP_XL};
use super::widgets::{btn, error, field, input};
use crate::core::session;

#[derive(Debug, Clone)]
pub enum Msg {
    Address(String),
    Password(String),
    Code(String),
    Submit,
}

pub struct Login {
    address: String,
    password: String,
    code: String,
    busy: bool,
    error: Option<String>,
}

impl Login {
    pub fn new(address: String) -> Self {
        Login { address, password: String::new(), code: String::new(), busy: false, error: None }
    }

    pub fn failed(&mut self, e: String) {
        self.busy = false;
        self.error = Some(e);
    }

    fn ready(&self) -> bool {
        !self.busy && !self.address.trim().is_empty() && !self.password.is_empty() && !self.code.trim().is_empty()
    }
}

pub fn update(l: &mut Login, m: Msg) -> Task<Message> {
    match m {
        Msg::Address(v) => l.address = v,
        Msg::Password(v) => l.password = v,
        Msg::Code(v) => l.code = v,
        Msg::Submit => {
            if !l.ready() {
                return Task::none();
            }
            l.busy = true;
            l.error = None;
            let (address, password, code) = (l.address.clone(), l.password.clone(), l.code.clone());
            return Task::perform(
                async move {
                    session::sign_in(&address, &password, &code, &session::device_name()).await.map_err(|e| e.message)
                },
                Message::SignedIn,
            );
        }
    }
    Task::none()
}

pub fn view(l: &Login) -> Element<'_, Msg> {
    let submit = l.ready().then_some(Msg::Submit);
    let form = column![
        row![icons::hat(36.0, false, |t: &Theme| theme::colors(t).hue), text("Sign in to Hatbot").size(FS_2XL)]
            .spacing(SP + 4.0)
            .align_y(Alignment::Center),
        field("Address", input("hatbot.example.com", &l.address, Msg::Address).on_submit_maybe(submit.clone())),
        field("Password", input("", &l.password, Msg::Password).secure(true).on_submit_maybe(submit.clone())),
        field("Code from your authenticator", input("123456", &l.code, Msg::Code).on_submit_maybe(submit.clone())),
    ]
    .push(l.error.as_deref().map(error))
    .push(row![
        iced::widget::Space::new().width(Length::Fill),
        btn(if l.busy { "Signing in" } else { "Sign in" }, theme::primary, submit)
    ])
    .spacing(SP_LG);
    container(container(form).padding(SP_XL + 8.0).width(464).style(theme::card))
        .center(Length::Fill)
        .style(theme::page)
        .into()
}
