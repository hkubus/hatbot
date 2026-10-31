// The window's frame, as the web's: the rail with the chats and sections, the top bar, the banners.
use iced::widget::{Space, button, column, container, mouse_area, opaque, row, scrollable, stack, text};
use std::f32::consts::FRAC_PI_2;

use iced::{Alignment, Element, Length, Padding, Radians, Theme};

use super::app::{App, Message, Route, Session};
use super::icons::{self, Icon};
use super::theme::{self, FS_LG, FS_MD, FS_SM, FS_XL, ICON, NAV_ICON, SP, SP_LG, SP_MD, SP_XS};
use super::widgets::{btn_sm, count, fill, icon_btn, icon_btn_styled};
use super::{chat, pages};
use crate::core::models::{Conversation, ConversationKind};

const RAIL: f32 = 272.0;
const COMPACT_RAIL: f32 = 96.0;

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

/// Ctrl with 1 to 4, K or comma goes to a section, as the sidebar lists them.
pub fn shortcut(s: &Session, key: &str) -> Option<Route> {
    let sec = match key {
        "1" => Section::Chat,
        "2" => Section::Tasks,
        "3" => Section::Memory,
        "4" => Section::Boxes,
        "k" => Section::Search,
        "," => Section::Settings,
        _ => return None,
    };
    views(s, sec).into_iter().next().map(|(r, _)| r)
}

/// The full sidebar where the window is wide, Material's compact rail between, and a tab bar where it's narrow.
#[derive(Clone, Copy, PartialEq)]
enum Nav {
    Full,
    Compact,
    Tabs,
}

fn nav(app: &App) -> Nav {
    if app.width < 900.0 {
        Nav::Tabs
    } else if app.width < 1200.0 || app.config.compact_sidebar {
        Nav::Compact
    } else {
        Nav::Full
    }
}

pub fn view<'a>(app: &'a App, s: &'a Session) -> Element<'a, Message> {
    let nav = nav(app);
    let main = column![toolbar(s, nav)]
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
            .style(if nav == Nav::Tabs { theme::page } else { theme::framed }),
        )
        .width(Length::Fill);
    match nav {
        Nav::Full => row![sidebar(s), main].into(),
        Nav::Compact => row![rail(s), main].into(),
        Nav::Tabs => {
            let body = column![main, tab_bar(s)];
            if s.chat_menu && s.route == Route::Chat {
                stack![
                    body,
                    mouse_area(Space::new().width(Length::Fill).height(Length::Fill))
                        .on_press(Message::ChatMenu(false)),
                    chat_menu(s)
                ]
                .into()
            } else {
                body.into()
            }
        }
    }
}

fn banner<'a>(words: &'a str, action: Element<'a, Message>) -> Element<'a, Message> {
    container(row![text(words).size(FS_MD), fill(), action].align_y(Alignment::Center).spacing(SP_MD))
        .padding(Padding::default().left(SP_LG + 8.0).right(SP_LG).top(SP_XS).bottom(SP_XS + 4.0))
        .width(Length::Fill)
        .into()
}

enum Glyph {
    Bot(String, String),
    Icon(Icon),
}

struct Entry {
    glyph: Glyph,
    name: String,
    badge: Option<usize>,
    lit: bool,
    on: Message,
}

impl Entry {
    fn glyph<'a>(&self) -> Element<'a, Message> {
        match &self.glyph {
            Glyph::Bot(icon, color) => icons::bot(icon, color, NAV_ICON, self.lit).into(),
            Glyph::Icon(i) if self.lit => icons::filled(*i, NAV_ICON, icons::text).into(),
            Glyph::Icon(i) => icons::icon(*i, NAV_ICON, icons::text_2).into(),
        }
    }
}

/// The chats, each a bot's own or a group; one Chat when there are none yet.
fn chats(s: &Session) -> Vec<Entry> {
    let in_chat = s.route == Route::Chat || s.route == Route::Threads;
    let open = s.store.listed_chat_id();
    let mut v: Vec<Entry> = s
        .store
        .conversations
        .iter()
        .filter(|c| !c.is_thread())
        .map(|c| Entry {
            glyph: chat_glyph(s, c),
            name: s.store.chat_name(Some(c)),
            badge: (c.unread > 0).then_some(c.unread as usize),
            lit: in_chat && c.id == open,
            on: Message::Chat(chat::Msg::Open(c.id)),
        })
        .collect();
    if v.is_empty() {
        v.push(Entry {
            glyph: Glyph::Icon(Icon::Chat),
            name: "Chat".into(),
            badge: None,
            lit: in_chat,
            on: Message::Go(Route::Chat),
        });
    }
    v
}

fn sections(s: &Session) -> Vec<Entry> {
    let sec = section(&s.route);
    let pending = s.store.needs_you();
    [
        (Section::Tasks, "Tasks", Icon::Tasks),
        (Section::Memory, "Memory", Icon::Book),
        (Section::Boxes, "Boxes", Icon::Box),
        (Section::Settings, "Settings", Icon::Sliders),
    ]
    .into_iter()
    .filter_map(|(sc, title, icon)| {
        let first = views(s, sc).into_iter().next()?.0;
        Some(Entry {
            glyph: Glyph::Icon(icon),
            name: title.into(),
            badge: (sc == Section::Tasks && pending > 0).then_some(pending),
            lit: sec == sc,
            on: Message::Go(first),
        })
    })
    .collect()
}

fn chat_glyph(s: &Session, c: &Conversation) -> Glyph {
    if c.kind == ConversationKind::Direct
        && let Some(b) = c.bot_ids.first().and_then(|id| s.store.bots.get(id))
    {
        return Glyph::Bot(b.icon.clone(), b.color.clone());
    }
    Glyph::Icon(if c.kind == ConversationKind::Group { Icon::Users } else { Icon::Chat })
}

fn nav_scroll<'a>(content: impl Into<Element<'a, Message>>) -> Element<'a, Message> {
    scrollable(container(content).padding(Padding::default().bottom(SP_LG)))
        .style(theme::scroll)
        .direction(scrollable::Direction::Vertical(scrollable::Scrollbar::new().width(0).scroller_width(0)))
        .height(Length::Fill)
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
    let list = |v: Vec<Entry>| column(v.into_iter().map(nav_item)).spacing(2);
    let rail = column![brand, nav_scroll(column![list(chats(s)), Space::new().height(SP_LG), list(sections(s))])]
        .padding(Padding::default().left(SP_MD).right(SP_MD));
    container(rail).width(RAIL).height(Length::Fill).into()
}

fn rail(s: &Session) -> Element<'_, Message> {
    let brand = column![
        icons::hat(28.0, false, |t: &Theme| theme::colors(t).hue),
        icon_btn(Icon::Plus, "New bot or group", Some(Message::Go(Route::NewBot))),
    ]
    .spacing(SP)
    .align_x(Alignment::Center)
    .width(Length::Fill)
    .padding([SP_MD, 0.0]);
    let list = |v: Vec<Entry>| column(v.into_iter().map(rail_item)).spacing(2);
    let items = column![list(chats(s)), Space::new().height(SP_MD), list(sections(s))];
    let rail = column![brand, nav_scroll(items)].padding(Padding::default().left(SP_XS).right(SP_XS));
    container(rail).width(COMPACT_RAIL).height(Length::Fill).into()
}

/// The sections along the bottom, chats first as one.
fn tab_bar(s: &Session) -> Element<'_, Message> {
    let unread: usize = s.store.conversations.iter().filter(|c| !c.is_thread()).map(|c| c.unread as usize).sum();
    let chat = Entry {
        glyph: Glyph::Icon(Icon::Chat),
        name: "Chat".into(),
        badge: (unread > 0).then_some(unread),
        lit: section(&s.route) == Section::Chat,
        on: Message::Go(Route::Chat),
    };
    let tabs = std::iter::once(chat).chain(sections(s)).map(|e| container(rail_item(e)).width(Length::Fill).into());
    container(row(tabs).align_y(Alignment::Center)).height(72).padding([0.0, SP_XS]).width(Length::Fill).into()
}

/// The chats, under the chat's name where there's no sidebar to list them.
fn chat_menu(s: &Session) -> Element<'_, Message> {
    let new = Entry {
        glyph: Glyph::Icon(Icon::Plus),
        name: "New bot or group".into(),
        badge: None,
        lit: false,
        on: Message::Go(Route::NewBot),
    };
    let items =
        chats(s).into_iter().map(|e| Entry { on: Message::Batch(vec![Message::ChatMenu(false), e.on.clone()]), ..e });
    let list = column(items.chain(std::iter::once(new)).map(nav_item)).spacing(2);
    let menu =
        container(scrollable(list).style(theme::scroll)).padding(SP_XS).width(300).max_height(480).style(theme::menu);
    container(opaque(menu)).padding(Padding::default().top(60).left(SP_LG)).into()
}

fn nav_item<'a>(e: Entry) -> Element<'a, Message> {
    let mut r = row![e.glyph(), text(e.name).size(FS_MD).font(theme::MEDIUM).width(Length::Fill)]
        .spacing(SP_MD)
        .align_y(Alignment::Center);
    if let Some(n) = e.badge {
        r = r.push(count(n));
    }
    button(r.height(Length::Fill))
        .height(56)
        .padding([0.0, SP_LG])
        .width(Length::Fill)
        .style(theme::nav(e.lit))
        .on_press(e.on)
        .into()
}

/// Material's rail item: the icon on a pill, its name under it.
fn rail_item<'a>(e: Entry) -> Element<'a, Message> {
    let pill: Element<'a, Message> = button(container(e.glyph()).center(Length::Fill))
        .width(56)
        .height(32)
        .padding(0)
        .style(theme::nav(e.lit))
        .on_press(e.on.clone())
        .into();
    let pill = match e.badge {
        Some(n) => stack![pill, container(count(n)).padding(Padding::default().left(32))].into(),
        None => pill,
    };
    let name = text(e.name).size(FS_SM).font(theme::MEDIUM).wrapping(text::Wrapping::None);
    button(column![pill, container(name).clip(true)].spacing(SP_XS).align_x(Alignment::Center).width(Length::Fill))
        .width(Length::Fill)
        .padding(Padding::default().top(SP_XS).bottom(SP))
        .style(theme::bare(e.lit))
        .on_press(e.on)
        .into()
}

fn toolbar(s: &Session, nav: Nav) -> Element<'_, Message> {
    let sec = section(&s.route);
    let mut bar = row![].spacing(SP_XS).align_y(Alignment::Center).height(64);
    if sec == Section::Chat && s.route != Route::NewBot {
        let chat = s.store.current_chat();
        let name = s.store.chat_name(chat);
        let title = if s.store.incognito { format!("{name} · Incognito") } else { name };
        if nav == Nav::Tabs && s.route == Route::Chat {
            let chevron = icons::icon(Icon::Chevron, ICON, icons::text_2).rotation(Radians(FRAC_PI_2));
            let open = s.chat_menu;
            bar = bar.push(
                button(row![text(title).size(FS_XL), chevron].spacing(SP_XS).align_y(Alignment::Center))
                    .padding([SP_XS, SP])
                    .style(theme::plain)
                    .on_press(Message::ChatMenu(!open)),
            );
        } else {
            bar = bar.push(text(title).size(FS_XL));
        }
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
    let underline = container(Space::new()).width(Length::Fill).height(3).style(move |t: &Theme| {
        let c = theme::colors(t);
        container::Style {
            background: active.then(|| c.hue.into()),
            border: iced::border::rounded(iced::border::Radius::default().top_left(3).top_right(3)),
            ..Default::default()
        }
    });
    button(column![container(label).center_y(Length::Fill), underline].width(Length::Shrink).height(Length::Fill))
        .height(Length::Fill)
        .padding([0.0, SP_LG])
        .style(theme::plain_square)
        .on_press(Message::Go(to))
        .into()
}
