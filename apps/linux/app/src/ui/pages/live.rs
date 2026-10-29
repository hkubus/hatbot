// Live: the desktop's screen as JPEG frames, and taking over from Hatbot.
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use iced::keyboard::{self, Key, key::Named};
use iced::widget::{column, container, image, mouse_area, responsive, row, stack, text};
use iced::{Alignment, Color, Element, Length, Point, Size, Subscription, Task, mouse};
use serde_json::json;

use super::Msg as PageMsg;
use crate::core::api::Api;
use crate::core::models::*;
use crate::core::socket::{self, SocketEvent};
use crate::core::{format, jpeg};
use crate::ui::app::{Message, Route, Session, failed};
use crate::ui::icons::{self, Icon};
use crate::ui::theme::{self, FS_LG, FS_MD, SP, SP_LG, SP_MD};
use crate::ui::widgets::{btn_icon, btn_sm, card, error, small, tiny, tone};

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum Conn {
    #[default]
    Connecting,
    Live,
    Offline,
}

#[derive(Debug, Clone)]
pub enum Msg {
    Ready(futures::channel::mpsc::Sender<String>),
    Conn(Conn),
    Frame(Vec<u8>),
    Screen(String),
    Takeover,
    Handback,
    Done(Result<DesktopState, String>),
    Typing,
    Moved(Point, Size),
    Button(u8, bool),
    Wheel(f32, f32),
    Key(String, bool),
}

#[derive(Default)]
pub struct State {
    frame: Option<image::Handle>,
    size: Option<(u32, u32)>,
    conn: Conn,
    out: Option<futures::channel::mpsc::Sender<String>>,
    screen: Option<String>,
    typing: bool,
    error: Option<String>,
    at: (f32, f32),
    last_move: Option<Instant>,
    /// A socket's frames go to the generation it was opened for.
    pub generation: u64,
}

fn m(msg: Msg) -> Message {
    Message::Page(PageMsg::Live(msg))
}

pub fn opened(s: &mut Session) -> Task<Message> {
    let st = &mut s.pages.live;
    st.error = None;
    st.generation += 1;
    st.conn = Conn::Connecting;
    if let Some(id) = s.store.desktop.as_ref().and_then(|d| d.active_task_id.or(d.request.as_ref().map(|r| r.task_id)))
        && !s.store.steps.contains_key(&id)
    {
        return load_steps(s, id);
    }
    Task::none()
}

fn load_steps(s: &Session, id: i64) -> Task<Message> {
    s.call(
        move |api| async move { api.get::<TaskWithSteps>(&format!("/tasks/{id}")).await },
        move |r| match r {
            Ok(t) => Message::Page(PageMsg::Tasks(super::tasks::Msg::Loaded(id, Ok(t)))),
            Err(_) => Message::Nothing,
        },
    )
}

fn send(st: &mut State, v: serde_json::Value) {
    if let Some(out) = &mut st.out {
        let _ = out.try_send(v.to_string());
    }
}

pub fn update(s: &mut Session, msg: Msg) -> Task<Message> {
    let control = s.store.desktop.as_ref().is_some_and(|d| d.control == Control::Owner);
    let st = &mut s.pages.live;
    match msg {
        Msg::Ready(out) => st.out = Some(out),
        Msg::Conn(c) => {
            st.conn = c;
            if c != Conn::Live {
                st.out = None;
            }
        }
        Msg::Frame(bytes) => {
            if let Some(size) = jpeg::size(&bytes) {
                st.size = Some(size);
            }
            st.frame = Some(image::Handle::from_bytes(bytes));
        }
        Msg::Screen(id) => {
            st.screen = Some(id);
            st.frame = None;
            st.conn = Conn::Connecting;
        }
        Msg::Takeover | Msg::Handback => {
            let path = if matches!(msg, Msg::Takeover) { "/desktop/takeover" } else { "/desktop/handback" };
            st.error = None;
            return s.call(
                move |api| async move { api.post::<DesktopState, _>(path, &json!({})).await },
                |r| match r {
                    Err(e) if e.is_unauthorized() => failed(e),
                    r => m(Msg::Done(r.map_err(|e| e.message))),
                },
            );
        }
        Msg::Done(Ok(d)) => {
            if d.control != Control::Owner {
                st.typing = false;
            }
            s.store.desktop = Some(d);
        }
        Msg::Done(Err(e)) => st.error = Some(e),
        Msg::Typing => st.typing = !st.typing,
        Msg::Moved(p, shown) => {
            let (w, h) = st.size.unwrap_or((1280, 800));
            st.at = (
                (p.x / shown.width.max(1.0) * w as f32).clamp(0.0, w as f32).round(),
                (p.y / shown.height.max(1.0) * h as f32).clamp(0.0, h as f32).round(),
            );
            // About 20 moves a second, as the web sends.
            if control && st.last_move.is_none_or(|t| t.elapsed() > Duration::from_millis(50)) {
                st.last_move = Some(Instant::now());
                let (x, y) = st.at;
                send(st, json!({ "t": "move", "x": x, "y": y }));
            }
        }
        Msg::Button(b, down) if control => {
            let (x, y) = st.at;
            send(st, json!({ "t": "button", "button": b, "down": down, "x": x, "y": y }));
        }
        Msg::Wheel(dx, dy) if control => {
            let (x, y) = st.at;
            send(st, json!({ "t": "wheel", "dx": dx, "dy": dy, "x": x, "y": y }));
        }
        Msg::Key(k, down) if control && st.typing => send(st, json!({ "t": "key", "key": k, "down": down })),
        Msg::Button(..) | Msg::Wheel(..) | Msg::Key(..) => {}
    }
    Task::none()
}

#[derive(Hash, Clone)]
struct LiveKey {
    server: String,
    token: String,
    path: String,
    generation: u64,
}

fn frames(key: &LiveKey) -> impl futures::Stream<Item = Message> + use<> {
    let key = key.clone();
    iced::stream::channel(8, async move |mut out: futures::channel::mpsc::Sender<Message>| {
        let api = Api::new(&key.server, Some(key.token.clone()));
        let (tx, mut rx) = futures::channel::mpsc::channel(4);
        let (input, outgoing) = futures::channel::mpsc::channel::<String>(64);
        let _ = out.send(m(Msg::Ready(input))).await;
        let run = socket::run(api, key.path.clone(), tx, outgoing, Duration::from_secs(15));
        let forward = async move {
            while let Some(e) = rx.next().await {
                let msg = match e {
                    SocketEvent::Open { .. } => m(Msg::Conn(Conn::Live)),
                    SocketEvent::Binary(b) => m(Msg::Frame(b)),
                    SocketEvent::Text(_) => continue,
                    SocketEvent::Closed => m(Msg::Conn(Conn::Offline)),
                    SocketEvent::Unauthorized => Message::Unauthorized,
                };
                if out.send(msg).await.is_err() {
                    break;
                }
            }
        };
        futures::join!(run, forward);
    })
}

/// DOM's key names, which the desktop takes.
fn key_name(key: &Key) -> Option<String> {
    match key {
        Key::Character(c) => Some(c.to_string()),
        Key::Named(Named::Space) => Some(" ".into()),
        Key::Named(Named::Super) => Some("Meta".into()),
        Key::Named(n) => Some(format!("{n:?}")),
        Key::Unidentified => None,
    }
}

pub fn subscription(s: &Session) -> Subscription<Message> {
    if s.route != Route::Live {
        return Subscription::none();
    }
    let st = &s.pages.live;
    let path = match &st.screen {
        Some(id) => format!("/desktop/live?screen={}", crate::core::api::query(id)),
        None => "/desktop/live".into(),
    };
    let mut subs = vec![Subscription::run_with(
        LiveKey {
            server: s.api.server.clone(),
            token: s.api.token.clone().unwrap_or_default(),
            path,
            generation: st.generation,
        },
        frames,
    )];
    if st.typing {
        subs.push(keyboard::listen().filter_map(|e| match e {
            keyboard::Event::KeyPressed { key, modified_key, .. } => {
                let k = if matches!(key, Key::Character(_)) { modified_key } else { key };
                key_name(&k).map(|n| m(Msg::Key(n, true)))
            }
            keyboard::Event::KeyReleased { key, modified_key, .. } => {
                let k = if matches!(key, Key::Character(_)) { modified_key } else { key };
                key_name(&k).map(|n| m(Msg::Key(n, false)))
            }
            _ => None,
        }));
    }
    Subscription::batch(subs)
}

pub fn typing(s: &Session) -> bool {
    s.pages.live.typing
}

pub fn view(s: &Session) -> Element<'_, Message> {
    let st = &s.pages.live;
    let desktop = s.store.desktop.as_ref();
    let control = desktop.is_some_and(|d| d.control == Control::Owner);
    let online = desktop.is_none_or(|d| d.online);
    let mut col = column![].spacing(SP_LG);

    if let Some(d) = desktop.filter(|d| d.screens.len() > 1) {
        let mut picker = row![].spacing(SP);
        let current = st.screen.clone().unwrap_or_else(|| d.screens[0].id.clone());
        for sc in &d.screens {
            let name = if sc.online { sc.name.clone() } else { format!("{} (offline)", sc.name) };
            picker = picker.push(
                iced::widget::button(text(name).size(FS_MD).font(theme::MEDIUM))
                    .padding([6, 14])
                    .style(theme::chip(sc.id == current))
                    .on_press(m(Msg::Screen(sc.id.clone()))),
            );
        }
        col = col.push(picker.wrap());
    }

    if control {
        col = col.push(banner("You're in control. Hatbot is paused.", "Hand back", m(Msg::Handback)));
    } else if let Some(r) = desktop.and_then(|d| d.request.as_ref()) {
        col = col.push(banner(&format!("Hatbot needs you: {}", r.reason), "Take over", m(Msg::Takeover)));
    }

    col = col.push(screen(st, control, online));

    let mut tools = row![].spacing(SP).align_y(Alignment::Center);
    if control {
        tools = tools.push(btn_icon(
            Icon::Keyboard,
            if st.typing { "Typing on the desktop" } else { "Type on the desktop" },
            if st.typing { theme::primary } else { theme::outlined },
            if st.typing { icons::on_hue } else { icons::text_2 },
            Some(m(Msg::Typing)),
        ));
    } else if desktop.is_some_and(|d| d.request.is_none() && d.online) {
        tools = tools.push(btn_icon(Icon::Hand, "Take over", theme::outlined, icons::hue, Some(m(Msg::Takeover))));
    }
    col = col.push(tools);
    if let Some(e) = &st.error {
        col = col.push(error(e.as_str()));
    }
    if let Some(id) = desktop.and_then(|d| d.active_task_id.or(d.request.as_ref().map(|r| r.task_id))) {
        col = col.push(task(s, id));
    }
    container(iced::widget::scrollable(container(col).padding([SP_LG, 32.0])).style(theme::scroll))
        .width(Length::Fill)
        .height(Length::Fill)
        .into()
}

fn banner<'a>(words: &str, action: &'a str, on: Message) -> Element<'a, Message> {
    container(
        row![
            icons::filled(Icon::Hand, 20.0, icons::hue),
            text(words.to_string()).size(FS_MD).width(Length::Fill),
            btn_sm(action, theme::primary, Some(on))
        ]
        .spacing(SP_MD)
        .align_y(Alignment::Center),
    )
    .padding(SP_LG)
    .width(Length::Fill)
    .style(theme::attention)
    .into()
}

fn screen(st: &State, control: bool, online: bool) -> Element<'_, Message> {
    let (fw, fh) = st.size.unwrap_or((1280, 800));
    let ratio = fh as f32 / fw as f32;
    let note = if !online || st.conn == Conn::Offline {
        Some("The desktop isn't answering.")
    } else if st.conn == Conn::Connecting || st.frame.is_none() {
        Some("Connecting…")
    } else {
        None
    };
    let frame = st.frame.clone();
    responsive(move |avail| {
        let w = avail.width.min(1600.0);
        let size = Size::new(w, w * ratio);
        let mut layers = stack![
            container(text(""))
                .width(size.width)
                .height(size.height)
                .style(|_| container::Style { background: Some(Color::BLACK.into()), ..Default::default() })
        ];
        if let (Some(f), true) = (&frame, online) {
            layers = layers.push(image(f.clone()).width(size.width).height(size.height));
        }
        if let Some(n) = note {
            layers = layers.push(
                container(text(n).size(FS_MD).color(Color::from_rgba(1.0, 1.0, 1.0, 0.8)))
                    .center(Length::Fill)
                    .width(size.width)
                    .height(size.height),
            );
        }
        let surface = mouse_area(layers)
            .on_move(move |p| m(Msg::Moved(p, size)))
            .on_press(m(Msg::Button(1, true)))
            .on_release(m(Msg::Button(1, false)))
            .on_middle_press(m(Msg::Button(2, true)))
            .on_middle_release(m(Msg::Button(2, false)))
            .on_right_press(m(Msg::Button(3, true)))
            .on_right_release(m(Msg::Button(3, false)))
            .on_scroll(|d| {
                // In wheel pixels, as a browser's deltaY: the desktop turns every 50 into a notch.
                let (dx, dy) = match d {
                    mouse::ScrollDelta::Lines { x, y } => (-x * 50.0, -y * 50.0),
                    mouse::ScrollDelta::Pixels { x, y } => (-x, -y),
                };
                m(Msg::Wheel(dx, dy))
            })
            .interaction(if control { mouse::Interaction::Crosshair } else { mouse::Interaction::Idle });
        container(surface)
            .padding(if control { 2 } else { 0 })
            .style(move |t| {
                let c = theme::colors(t);
                container::Style {
                    border: iced::Border {
                        color: if control { c.hue } else { c.line },
                        width: 2.0,
                        radius: 12.0.into(),
                    },
                    ..Default::default()
                }
            })
            .into()
    })
    .height(Length::Shrink)
    .into()
}

fn task(s: &Session, id: i64) -> Element<'_, Message> {
    let Some(t) = s.store.tasks.get(&id) else { return column![].into() };
    let mut col = column![
        iced::widget::button(text(t.title.as_str()).size(FS_LG).font(theme::MEDIUM))
            .padding(0)
            .style(theme::link)
            .on_press(Message::Go(Route::Task(id))),
        small(format::task_line(t, s.store.task_progress.get(&id).map(String::as_str))),
    ]
    .spacing(SP);
    if let Some(steps) = s.store.steps.get(&id) {
        for step in latest_note_only(steps).into_iter().rev().take(6) {
            let lit = matches!(step.kind, StepKind::Approval | StepKind::Takeover);
            col = col.push(
                row![
                    tiny(format::time_text(&step.created_at)),
                    text(if step.detail.is_empty() { step.name.as_str() } else { step.detail.as_str() })
                        .size(FS_MD)
                        .style(tone(if lit { |c| c.hue } else { |c| c.text })),
                ]
                .spacing(SP),
            );
        }
    }
    card(col).into()
}
