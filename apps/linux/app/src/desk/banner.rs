// "Hatbot is using this computer", on top of everything while a task holds the screen. It runs as
// `hatbot --banner` in a process of its own, so the layer surface has its own event loop; its Stop is
// written to stdout for the daemon to act on.
use std::process::Stdio;

use iced::widget::{button, container, row, text};
use iced::{Alignment, Color, Element, Length, Task, Theme};
use iced_layershell::reexport::{Anchor, KeyboardInteractivity, Layer};
use iced_layershell::settings::{LayerShellSettings, Settings, StartMode};
use iced_layershell::to_layer_message;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use super::inbox::{self, Outside};
use crate::ui::icons;
use crate::ui::theme::{self, FS_MD, H, SP, SP_LG};

#[to_layer_message]
#[derive(Debug, Clone)]
enum Message {
    Stop,
}

#[derive(Default)]
struct Banner {
    stopped: bool,
}

fn update(b: &mut Banner, m: Message) -> Task<Message> {
    if let Message::Stop = m {
        b.stopped = true;
        println!("stop");
    }
    Task::none()
}

fn view(b: &Banner) -> Element<'_, Message> {
    let stop = button(
        container(text(if b.stopped { "Stopping" } else { "Stop" }).size(FS_MD).font(theme::MEDIUM))
            .center_y(Length::Fill),
    )
    .height(H - 8.0)
    .padding([0.0, SP_LG])
    .style(theme::danger)
    .on_press_maybe((!b.stopped).then_some(Message::Stop));
    let pill = container(
        row![
            icons::hat(22.0, true, |t: &Theme| theme::colors(t).hue),
            text("Hatbot is using this computer").size(FS_MD).font(theme::MEDIUM),
            stop
        ]
        .spacing(SP + 4.0)
        .align_y(Alignment::Center),
    )
    .padding([4.0, 6.0])
    .padding(iced::Padding { left: SP_LG, ..iced::Padding::new(4.0) })
    .style(|t: &Theme| {
        let c = theme::colors(t);
        container::Style {
            background: Some(c.surface_3.into()),
            text_color: Some(c.text),
            border: iced::border::rounded(theme::PILL),
            ..Default::default()
        }
    });
    container(pill).center(Length::Fill).into()
}

pub fn run(output: Option<String>) -> Result<(), iced_layershell::Error> {
    let start_mode = output.map(StartMode::TargetScreen).unwrap_or_default();
    let mut app = iced_layershell::application(Banner::default, || "hatbot-banner".to_string(), update, view)
        .style(|_: &Banner, t: &Theme| iced::theme::Style {
            background_color: Color::TRANSPARENT,
            text_color: theme::colors(t).text,
        })
        .theme(|_: &Banner| Some(theme::theme(true)))
        .default_font(theme::TEXT)
        .settings(Settings {
            layer_settings: LayerShellSettings {
                anchor: Anchor::Top,
                layer: Layer::Overlay,
                exclusive_zone: 0,
                size: Some((380, 56)),
                margin: (8, 0, 0, 0),
                keyboard_interactivity: KeyboardInteractivity::None,
                start_mode,
                ..Default::default()
            },
            ..Default::default()
        });
    for f in theme::FONTS {
        app = app.font(f);
    }
    app.run()
}

/// The banner's process while it shows.
pub struct Shown {
    child: Child,
}

impl Shown {
    pub fn start(output: Option<&str>) -> Option<Shown> {
        let exe = std::env::current_exe().ok()?;
        let mut cmd = Command::new(exe);
        cmd.arg("--banner");
        if let Some(o) = output {
            cmd.arg(o);
        }
        let mut child = cmd.stdout(Stdio::piped()).stdin(Stdio::null()).kill_on_drop(true).spawn().ok()?;
        let out = child.stdout.take()?;
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if l.trim() == "stop" {
                    inbox::send(Outside::StopComputer);
                }
            }
        });
        Some(Shown { child })
    }

    pub fn stop(mut self) {
        let _ = self.child.start_kill();
    }
}
