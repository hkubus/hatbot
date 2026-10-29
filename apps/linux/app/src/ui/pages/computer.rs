// This computer: whether Hatbot may use it, which only this app can switch on, and what it's doing.
use iced::widget::{column, container, row, text};
use iced::{Alignment, Element, Length, Task};

use super::Msg as PageMsg;
use crate::ui::app::{App, Message};
use crate::ui::theme::{self, FS_TEXT, SP, SP_LG, SP_MD, SP_XL};
use crate::ui::widgets::{btn, btn_sm, card, labeled, page, section, small, switch_row};

/// Keeps password managers out of what Hatbot sees: niri blacks out their windows in screen captures.
pub const NIRI_RULE: &str = r##"window-rule {
    match app-id=r#"^org\.keepassxc\.KeePassXC$"#
    match app-id=r#"^1Password$"#
    match app-id=r#"^Bitwarden$"#
    match app-id=r#"^com\.belmoussaoui\.Authenticator$"#
    block-out-from "screen-capture"
}"##;

#[derive(Debug, Clone)]
pub enum Msg {
    Enabled(bool),
    Pause(bool),
    Stop,
}

pub fn update(app: &mut App, msg: Msg) -> Task<Message> {
    match msg {
        Msg::Enabled(on) => app.set_computer_enabled(on),
        Msg::Pause(on) => {
            if let Some(a) = app.agent() {
                if on { a.pause() } else { a.resume() }
            }
        }
        Msg::Stop => {
            if let Some(a) = app.agent() {
                a.stop_task();
            }
        }
    }
    Task::none()
}

fn m(msg: Msg) -> Message {
    Message::Page(PageMsg::Computer(msg))
}

pub fn view(app: &App) -> Element<'_, Message> {
    let st = &app.agent_state;
    let on = app.config.computer_enabled;
    let mut col = column![card(switch_row("Let Hatbot use this computer", None, on, Some(|v| m(Msg::Enabled(v)))))]
        .spacing(SP_XL);
    if on {
        let mut status = column![].spacing(SP_MD);
        let connection = if st.online { "Connected to Hatbot" } else { "Not connected to Hatbot" };
        status = status.push(labeled("Connection", text(connection).size(FS_TEXT)));
        let you = if st.status.locked {
            "Locked"
        } else if st.status.owner_active {
            "You're using it"
        } else {
            "Idle"
        };
        status = status.push(labeled("This computer", text(you).size(FS_TEXT)));
        if let Some(sc) = &st.status.screen {
            let size = format!("{}, {} × {}", sc.output, sc.width as i64, sc.height as i64);
            status = status.push(labeled("Screen", text(size).size(FS_TEXT)));
        }
        if let Some(task) = &st.task {
            status = status.push(
                row![
                    text(format!("Hatbot is using it: {task}")).size(FS_TEXT).width(Length::Fill),
                    btn_sm("Stop", theme::danger, Some(m(Msg::Stop)))
                ]
                .spacing(SP)
                .align_y(Alignment::Center),
            );
        }
        let paused = st.status.paused;
        status = status.push(row![if paused {
            btn("Resume", theme::primary, Some(m(Msg::Pause(false))))
        } else {
            btn("Pause", theme::outlined, Some(m(Msg::Pause(true))))
        }]);
        col = col.push(section("Status", card(status)));
    }
    col = col.push(section(
        "Keep passwords out of sight",
        column![
            small("Add this to niri's config.kdl. Windows it matches show black to Hatbot. Add your own apps the same way."),
            container(text(NIRI_RULE).size(13).font(theme::CODE)).padding(SP_LG).width(Length::Fill).style(theme::code_block),
            row![btn_sm("Copy", theme::tonal, Some(Message::Copy(NIRI_RULE.to_string())))]
        ]
        .spacing(SP_MD),
    ));
    page(col)
}
