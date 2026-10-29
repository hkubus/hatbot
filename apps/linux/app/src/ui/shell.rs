// The window's frame, as the web's: the rail with the chats and sections, the top bar, the banners.
use iced::widget::{Space, button, column, container, row, scrollable, text};
use iced::{Alignment, Element, Length, Padding, Theme};

use super::app::{App, Message, Route, Session};
use super::icons::{self, Icon};
use super::theme::{self, FS_LG, FS_MD, FS_SM, FS_XL, NAV_ICON, SP, SP_LG, SP_MD, SP_XS};
use super::widgets::{btn_sm, count, fill, icon_btn, icon_btn_styled};
use super::{chat, pages};
use crate::core::models::{Conversation, ConversationKind};

const RAIL: f32 = 272.0;

#[derive(Clone, Copy, PartialEq)]
enum Section {
    Chat,
    Tasks,
    Memory,
    Boxes,
    Search,
    Settings,
}

fn section(r: &Route) -> Section {
    match r {
        Route::Chat | Route::Threads | Route::Bot(_) | Route::NewBot | Route::Group(_) => Section::Chat,
        Route::Tasks | Route::Task(_) | Route::Live | Route::Schedules => Section::Tasks,
        Route::Memory | Route::Todo => Section::Memory,
        Route::Boxes => Section::Boxes,
        Route::Search => Section::Search,
        Route::Settings | Route::Spend | Route::Computer => Section::Settings,
    }
}

/// A section's views, shown as tabs when there's more than one. Plugins that are off take theirs away.
fn views(s: &Session, sec: Section) -> Vec<(Route, &'static str)> {
    let mut v = match sec {
        Section::Tasks => vec![(Route::Tasks, "Tasks"), (Route::Live, "Live"), (Route::Schedules, "Automations")],
        Section::Memory => vec![(Route::Memory, "Memory"), (Route::Todo, "To-do")],
        Section::Settings => {
            vec![(Route::Settings, "Settings"), (Route::Spend, "Spend"), (Route::Computer, "This computer")]
        }
        Section::Boxes => vec![(Route::Boxes, "Boxes")],
        Section::Search => vec![(Route::Search, "Search")],
        Section::Chat => vec![(Route::Chat, "Chat")],
    };
    v.retain(|(r, _)| match r {
        Route::Live => s.plugin_on("desktop"),
        Route::Schedules => s.plugin_on("automation"),
        Route::Boxes => s.plugin_on("boxes"),
        _ => true,
    });
    v
}

pub fn view<'a>(app: &'a App, s: &'a Session) -> Element<'a, Message> {
    let main = column![toolbar(s)]
        .push(
            s.unreachable
                .then(|| banner("Can't reach Hatbot.", btn_sm("Retry", theme::outlined, Some(Message::Retry)).into())),
        )
        .push(s.store.paused.then(|| {
            banner("All activity is paused.", btn_sm("Resume", theme::primary, Some(Message::SetPaused(false))).into())
        }))
        .push(
            container(match &s.route {
                Route::Chat => chat::view(app, s),
                _ => pages::view(app, s),
            })
            .width(Length::Fill)
            .height(Length::Fill)
            .style(theme::framed),
        );
    row![sidebar(s), main.width(Length::Fill)].into()
}

fn banner<'a>(words: &'a str, action: Element<'a, Message>) -> Element<'a, Message> {
    container(row![text(words).size(FS_MD), fill(), action].align_y(Alignment::Center).spacing(SP_MD))
        .padding(Padding::default().left(SP_LG + 8.0).right(SP_LG).top(SP_XS).bottom(SP_XS + 4.0))
        .width(Length::Fill)
        .into()
}

fn sidebar(s: &Session) -> Element<'_, Message> {
    let brand = row![
        container(icons::hat(28.0, false, |t: &Theme| theme::colors(t).hue)).padding([0, 6]),
        text("Hatbot").size(FS_XL).font(theme::TEXT),
        fill(),
        icon_btn(Icon::Plus, "New bot or group", Some(Message::Go(Route::NewBot))),
    ]
    .spacing(SP)
    .align_y(Alignment::Center)
    .height(64);

    let sec = section(&s.route);
    let in_chat = s.route == Route::Chat || s.route == Route::Threads;
    let open = s.store.listed_chat_id();
    let mut chats = column![].spacing(2);
    let listed: Vec<&Conversation> = s.store.conversations.iter().filter(|c| !c.is_thread()).collect();
    for c in &listed {
        let lit = in_chat && c.id == open;
        chats = chats.push(nav_item(
            chat_icon(s, c, lit),
            s.store.chat_name(Some(c)),
            (c.unread > 0).then_some(c.unread as usize),
            lit,
            Message::Chat(chat::Msg::Open(c.id)),
        ));
    }
    if listed.is_empty() {
        chats = chats.push(nav_item(
            if in_chat {
                icons::filled(Icon::Chat, NAV_ICON, icons::text).into()
            } else {
                icons::icon(Icon::Chat, NAV_ICON, icons::text_2).into()
            },
            "Chat".into(),
            None,
            in_chat,
            Message::Go(Route::Chat),
        ));
    }

    let pending = s.store.needs_you();
    let mut sections = column![].spacing(2);
    for (sc, title, icon, first) in [
        (Section::Tasks, "Tasks", Icon::Tasks, Route::Tasks),
        (Section::Memory, "Memory", Icon::Book, Route::Memory),
        (Section::Boxes, "Boxes", Icon::Box, Route::Boxes),
        (Section::Settings, "Settings", Icon::Sliders, Route::Settings),
    ] {
        if views(s, sc).is_empty() {
            continue;
        }
        let lit = sec == sc;
        let glyph: Element<'_, Message> = if lit {
            icons::filled(icon, NAV_ICON, icons::text).into()
        } else {
            icons::icon(icon, NAV_ICON, icons::text_2).into()
        };
        let badge = (sc == Section::Tasks && pending > 0).then_some(pending);
        sections = sections.push(nav_item(glyph, title.into(), badge, lit, Message::Go(first)));
    }

    let rail = column![
        brand,
        scrollable(column![chats, Space::new().height(SP_LG), sections].padding(Padding::default().bottom(SP_LG)))
            .style(theme::scroll)
            .direction(scrollable::Direction::Vertical(scrollable::Scrollbar::new().width(0).scroller_width(0)))
            .height(Length::Fill)
    ]
    .padding(Padding::default().left(SP_MD).right(SP_MD));
    container(rail).width(RAIL).height(Length::Fill).into()
}

fn chat_icon<'a>(s: &'a Session, c: &Conversation, lit: bool) -> Element<'a, Message> {
    if c.kind == ConversationKind::Direct
        && let Some(b) = c.bot_ids.first().and_then(|id| s.store.bots.get(id))
    {
        return icons::bot(&b.icon, &b.color, NAV_ICON, lit).into();
    }
    let i = if c.kind == ConversationKind::Group { Icon::Users } else { Icon::Chat };
    if lit { icons::filled(i, NAV_ICON, icons::text).into() } else { icons::icon(i, NAV_ICON, icons::text_2).into() }
}

fn nav_item<'a>(
    glyph: Element<'a, Message>,
    name: String,
    badge: Option<usize>,
    lit: bool,
    on: Message,
) -> Element<'a, Message> {
    let mut r = row![glyph, text(name).size(FS_MD).font(theme::MEDIUM).width(Length::Fill)]
        .spacing(SP_MD)
        .align_y(Alignment::Center);
    if let Some(n) = badge {
        r = r.push(count(n));
    }
    button(r.height(Length::Fill))
        .height(56)
        .padding([0.0, SP_LG])
        .width(Length::Fill)
        .style(theme::nav(lit))
        .on_press(on)
        .into()
}

fn toolbar(s: &Session) -> Element<'_, Message> {
    let sec = section(&s.route);
    let mut bar = row![].spacing(SP_XS).align_y(Alignment::Center).height(64);
    if sec == Section::Chat && s.route != Route::NewBot {
        let chat = s.store.current_chat();
        let name = s.store.chat_name(chat);
        let title = if s.store.incognito { format!("{name} · Incognito") } else { name };
        bar = bar.push(text(title).size(FS_XL));
        let thread = chat.filter(|c| c.is_thread());
        if let Some(c) = chat.filter(|_| thread.is_none()) {
            let about = match c.kind {
                ConversationKind::Group => Route::Group(Some(c.id)),
                _ => Route::Bot(c.bot_ids.first().cloned().unwrap_or_else(|| "hatbot".into())),
            };
            bar = bar.push(icon_btn(Icon::Sliders, "About", Some(Message::Go(about))));
        }
        bar = bar.push(fill());
        if let Some(t) = thread {
            if let Some(parent) = t.parent_id {
                bar = bar.push(btn_sm("Back", theme::plain, Some(Message::Chat(chat::Msg::Open(parent)))));
            }
            if t.resolved_at.is_none() {
                bar = bar.push(btn_sm("Resolve", theme::outlined, Some(Message::Chat(chat::Msg::Resolve(t.id)))));
            }
        } else if let Some(c) = chat {
            if c.kind == ConversationKind::Direct {
                let open: Vec<&Conversation> =
                    s.store.threads.values().filter(|t| t.parent_id == Some(c.id) && t.resolved_at.is_none()).collect();
                let on = s.route == Route::Threads;
                let target = if on { Route::Chat } else { Route::Threads };
                let mut b = row![icon_btn_styled(Icon::Forum, "Threads", Some(Message::Go(target)), on)]
                    .align_y(Alignment::Center);
                if !open.is_empty() {
                    let needs = open.iter().any(|t| s.store.thread_needs_you(t));
                    b = b.push(text(open.len().to_string()).size(FS_SM).style(move |t: &Theme| {
                        let c = theme::colors(t);
                        text::Style { color: Some(if needs { c.hue } else { c.muted }) }
                    }));
                }
                bar = bar.push(b);
            }
            if c.kind != ConversationKind::Group {
                let on = s.store.incognito;
                bar = bar.push(icon_btn_styled(
                    Icon::Incognito,
                    if on { "Leave incognito" } else { "Incognito" },
                    Some(Message::Chat(chat::Msg::Incognito(!on))),
                    on,
                ));
            }
        }
    } else {
        let tabs = views(s, sec);
        if tabs.len() > 1 {
            let active = tab_of(&s.route);
            let mut t = row![].height(Length::Fill);
            for (r, name) in tabs {
                t = t.push(tab(name, active == r, r));
            }
            bar = bar.push(t);
        } else {
            bar = bar.push(text(pages::title(s)).size(FS_XL));
        }
        bar = bar.push(fill());
    }
    bar = bar.push(icon_btn_styled(Icon::Search, "Search", Some(Message::Go(Route::Search)), s.route == Route::Search));
    container(bar).padding(Padding::default().left(SP_LG + 8.0).right(SP_MD)).width(Length::Fill).into()
}

/// The tab a page belongs to.
fn tab_of(r: &Route) -> Route {
    match r {
        Route::Task(_) => Route::Tasks,
        other => other.clone(),
    }
}

fn tab(name: &str, active: bool, to: Route) -> Element<'_, Message> {
    let label = text(name).size(FS_LG).font(theme::MEDIUM).style(move |t: &Theme| {
        let c = theme::colors(t);
        text::Style { color: Some(if active { c.hue } else { c.text_2 }) }
    });
    let underline = container(Space::new().height(3).width(Length::Fill)).style(move |t: &Theme| {
        let c = theme::colors(t);
        container::Style {
            background: active.then(|| c.hue.into()),
            border: iced::border::rounded(iced::border::Radius::default().top_left(3).top_right(3)),
            ..Default::default()
        }
    });
    button(column![container(label).center_y(Length::Fill), underline].width(Length::Shrink).align_x(Alignment::Center))
        .height(Length::Fill)
        .padding([0.0, SP_LG])
        .style(theme::plain_square)
        .on_press(Message::Go(to))
        .into()
}
