// Asking before something that can't be undone, over the window as the web's confirm.tsx does.
use iced::widget::{column, container, mouse_area, opaque, row, text};
use iced::{Element, Length, Task};

use super::app::Message;
use super::theme::{self, FS_MD, FS_XL, SP, SP_LG, SP_XL};
use super::widgets::{btn, fill, tone};

#[derive(Debug, Clone)]
pub struct Dialog {
    pub title: String,
    pub body: String,
    pub action: String,
    pub on: Message,
}

/// Asks, and sends `on` when the owner goes ahead.
pub fn ask(title: impl Into<String>, body: impl Into<String>, action: impl Into<String>, on: Message) -> Task<Message> {
    Task::done(Message::Ask(Box::new(Dialog { title: title.into(), body: body.into(), action: action.into(), on })))
}

pub fn view(d: &Dialog) -> Element<'_, Message> {
    let card = container(
        column![
            text(d.title.as_str()).size(FS_XL),
            text(d.body.as_str()).size(FS_MD).style(tone(|c| c.text_2)),
            row![
                fill(),
                btn("Cancel", theme::plain, Some(Message::Answer(false))),
                btn(d.action.as_str(), theme::danger, Some(Message::Answer(true)))
            ]
            .spacing(SP)
        ]
        .spacing(SP_LG),
    )
    .padding(SP_XL)
    .max_width(420)
    .style(theme::dialog);
    opaque(
        mouse_area(container(opaque(card)).center(Length::Fill).style(theme::scrim)).on_press(Message::Answer(false)),
    )
}
