// A bot's settings and a group's, and making new ones.
use iced::widget::{button, column, container, row, text, text_editor};
use iced::{Alignment, Element, Length, Task};

use super::Msg as PageMsg;
use crate::core::format;
use crate::core::models::*;
use crate::ui::app::{self, Message, Route, Session, failed};
use crate::ui::confirm;
use crate::ui::icons;
use crate::ui::theme::{self, FS_TEXT, R_MD, SP, SP_MD, SP_XL};
use crate::ui::widgets::{
    Choice, area, btn, card, error, field, fill, input, page, picker, section, segmented, small, switch_row,
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Making {
    Bot,
    Group,
}

#[derive(Debug, Clone)]
pub enum Msg {
    Loaded(Box<Bot>),
    Templates(Vec<BotTemplate>),
    Models(Vec<ModelOption>),
    Making(Making),
    Template(Choice),
    Name(String),
    Icon(&'static str),
    Color(&'static str),
    Role(text_editor::Action),
    Model(Choice),
    Effort(Choice),
    AllPlugins(bool),
    Plugin(String, bool),
    Save,
    Saved(Result<Bot, String>),
    Delete,
    DeleteSure(String),
    Title(String),
    Member(String, bool),
    SaveGroup,
    GroupSaved(Result<Conversation, String>),
    DeleteGroup(i64),
    DeleteGroupSure(i64),
}

struct Form {
    name: String,
    icon: String,
    color: String,
    role: text_editor::Content,
    chat_model: Option<String>,
    chat_effort: Option<String>,
    plugins: Option<Vec<String>>,
}

impl Form {
    fn of(b: &Bot) -> Form {
        Form {
            name: b.name.clone(),
            icon: b.icon.clone(),
            color: b.color.clone(),
            role: text_editor::Content::with_text(&b.instructions),
            chat_model: b.chat_model.clone(),
            chat_effort: b.chat_effort.clone(),
            plugins: b.plugins.clone(),
        }
    }

    fn change(&self, rename: bool) -> BotChange {
        BotChange {
            name: rename.then(|| self.name.trim().to_string()),
            icon: self.icon.clone(),
            color: self.color.clone(),
            instructions: self.role.text().trim_end().to_string(),
            chat_model: self.chat_model.clone(),
            chat_effort: self.chat_effort.clone(),
            plugins: self.plugins.clone(),
        }
    }

    fn same_as(&self, b: &Bot) -> bool {
        self.change(true) == Form::of(b).change(true)
    }
}

#[derive(Default)]
pub struct State {
    making: Option<Making>,
    form: Option<Form>,
    /// The bot whole, as the form was filled from it: the list's may have only its role's first line.
    base: Option<Bot>,
    templates: Vec<BotTemplate>,
    template: Option<String>,
    models: Vec<ModelOption>,
    busy: bool,
    error: Option<String>,
    title: String,
    members: Vec<String>,
}

fn m(msg: Msg) -> Message {
    Message::Page(PageMsg::Bots(msg))
}

const HATBOT: &str = "hatbot";

fn models(s: &Session) -> Task<Message> {
    s.call(
        |api| async move { api.get::<Vec<ModelOption>>("/models").await },
        |r| r.map(|l| m(Msg::Models(l))).unwrap_or(Message::Nothing),
    )
}

/// A colour no bot has yet, or the one fewest have.
fn free_color(s: &Session) -> String {
    let used: Vec<&str> =
        s.store.bot_ids.iter().filter_map(|id| s.store.bots.get(id)).map(|b| b.color.as_str()).collect();
    BOT_COLORS.iter().min_by_key(|c| used.iter().filter(|u| **u == **c).count()).unwrap_or(&"amber").to_string()
}

fn blank(s: &Session) -> Form {
    Form {
        name: String::new(),
        icon: "sparkles".into(),
        color: free_color(s),
        role: text_editor::Content::new(),
        chat_model: None,
        chat_effort: None,
        plugins: None,
    }
}

pub fn opened(s: &mut Session, r: &Route) -> Task<Message> {
    let st = &mut s.pages.bots;
    st.error = None;
    st.busy = false;
    match r {
        Route::Bot(id) => {
            let id = id.clone();
            st.making = None;
            st.base = None;
            st.form = s.store.bots.get(&id).map(Form::of);
            let t = s.call(
                move |api| async move { api.get::<Bot>(&format!("/bots/{id}")).await },
                |r| match r {
                    Ok(b) => m(Msg::Loaded(Box::new(b))),
                    Err(e) => failed(e),
                },
            );
            Task::batch([t, models(s)])
        }
        Route::NewBot => {
            st.making = Some(Making::Bot);
            st.base = None;
            st.template = None;
            st.title.clear();
            st.members.clear();
            s.pages.bots.form = Some(blank(s));
            let t = s.call(
                |api| async move { api.get::<Vec<BotTemplate>>("/bot-templates").await },
                |r| r.map(|l| m(Msg::Templates(l))).unwrap_or(Message::Nothing),
            );
            Task::batch([t, models(s)])
        }
        Route::Group(id) => {
            let c = id.and_then(|id| s.store.conversations.iter().find(|c| c.id == id));
            st.title = c.and_then(|c| c.title.clone()).unwrap_or_default();
            st.members = c.map(|c| c.bot_ids.clone()).unwrap_or_default();
            Task::none()
        }
        _ => Task::none(),
    }
}

pub fn update(s: &mut Session, msg: Msg) -> Task<Message> {
    let st = &mut s.pages.bots;
    match msg {
        Msg::Loaded(b) => {
            if s.route == Route::Bot(b.id.clone()) {
                // Edits already made to what the list had are kept; the role comes whole.
                let untouched = match (&st.form, s.store.bots.get(&b.id)) {
                    (Some(f), Some(listed)) => f.same_as(listed),
                    _ => true,
                };
                if untouched {
                    st.form = Some(Form::of(&b));
                }
                st.base = Some(*b);
            }
        }
        Msg::Templates(l) => st.templates = l,
        Msg::Models(l) => st.models = l,
        Msg::Making(k) => st.making = Some(k),
        Msg::Template(c) => {
            let form = match s.pages.bots.templates.iter().find(|t| t.id == c.id) {
                Some(t) => Form {
                    name: t.name.clone(),
                    icon: t.icon.clone(),
                    color: t.color.clone(),
                    role: text_editor::Content::with_text(&t.instructions),
                    chat_model: t.chat_model.clone(),
                    chat_effort: t.chat_effort.clone(),
                    plugins: t.plugins.clone(),
                },
                None => blank(s),
            };
            s.pages.bots.template = Some(c.id).filter(|id| !id.is_empty());
            s.pages.bots.form = Some(form);
        }
        Msg::Name(v) => {
            if let Some(f) = &mut st.form {
                f.name = v;
            }
        }
        Msg::Icon(i) => {
            if let Some(f) = &mut st.form {
                f.icon = i.into();
            }
        }
        Msg::Color(c) => {
            if let Some(f) = &mut st.form {
                f.color = c.into();
            }
        }
        Msg::Role(a) => {
            if let Some(f) = &mut st.form {
                f.role.perform(a);
            }
        }
        Msg::Model(c) => {
            if let Some(f) = &mut st.form {
                f.chat_model = Some(c.id).filter(|id| !id.is_empty());
            }
        }
        Msg::Effort(c) => {
            if let Some(f) = &mut st.form {
                f.chat_effort = Some(c.id).filter(|id| !id.is_empty());
            }
        }
        Msg::AllPlugins(all) => {
            if let Some(f) = &mut st.form {
                f.plugins = if all {
                    None
                } else {
                    Some(s.plugins.iter().flatten().filter(|p| p.enabled).map(|p| p.id.clone()).collect())
                };
            }
        }
        Msg::Plugin(id, on) => {
            if let Some(f) = &mut st.form
                && let Some(list) = &mut f.plugins
            {
                list.retain(|p| *p != id);
                if on {
                    list.push(id);
                }
            }
        }
        Msg::Save => {
            let Some(f) = &st.form else { return Task::none() };
            st.busy = true;
            let answer = |r: Result<Bot, crate::core::api::ApiError>| m(Msg::Saved(r.map_err(|e| e.message)));
            return match &s.route {
                Route::Bot(id) => {
                    let (id, change) = (id.clone(), f.change(id != HATBOT));
                    s.call(move |api| async move { api.patch::<Bot, _>(&format!("/bots/{id}"), &change).await }, answer)
                }
                _ => {
                    let change = f.change(true);
                    s.call(move |api| async move { api.post::<Bot, _>("/bots", &change).await }, answer)
                }
            };
        }
        Msg::Saved(Ok(b)) => {
            st.busy = false;
            let made = s.route == Route::NewBot;
            st.form = Some(Form::of(&b));
            st.base = Some(b.clone());
            s.store.bots.insert(b.id.clone(), b.clone());
            if made {
                // Its chat comes with it, so the list is loaded again to open it.
                let (id, name) = (b.id.clone(), b.name.clone());
                return Task::batch([
                    s.call(
                        |api| async move {
                            let bots: Vec<Bot> = api.get("/bots").await?;
                            let chats: Vec<Conversation> = api.get("/conversations").await?;
                            Ok((bots, chats))
                        },
                        move |r| match r {
                            Ok((bots, chats)) => {
                                let open = match chats.iter().find(|c| c.bot_ids.first() == Some(&id)) {
                                    Some(c) => Message::Chat(crate::ui::chat::Msg::Open(c.id)),
                                    None => Message::Go(Route::Chat),
                                };
                                Message::Batch(vec![Message::Loaded(app::Loaded::Chats(bots, chats)), open])
                            }
                            Err(e) => failed(e),
                        },
                    ),
                    Task::done(Message::Toast(format!("Made {name}."))),
                ]);
            }
            return Task::done(Message::Toast("Saved.".into()));
        }
        Msg::Saved(Err(e)) => {
            st.busy = false;
            st.error = Some(e);
        }
        Msg::Delete => {
            let Route::Bot(id) = &s.route else { return Task::none() };
            let name = s.store.bots.get(id).map(|b| b.name.clone()).unwrap_or_else(|| "this bot".into());
            return confirm::ask(
                format!("Delete {name}?"),
                "Its chat goes away. Its notes stay in Memory, and its schedules, triggers and watchers go to \
                 Hatbot, switched off until you turn them back on.",
                "Delete",
                m(Msg::DeleteSure(id.clone())),
            );
        }
        Msg::DeleteSure(id) => {
            return Task::batch([
                s.call(
                    move |api| async move { api.delete(&format!("/bots/{id}")).await },
                    |r| r.err().map(failed).unwrap_or(Message::Nothing),
                ),
                Task::done(Message::Go(Route::Chat)),
            ]);
        }
        Msg::Title(v) => st.title = v,
        Msg::Member(id, on) => {
            st.members.retain(|b| *b != id);
            if on {
                st.members.push(id);
            }
        }
        Msg::SaveGroup => {
            let change = GroupChange { title: st.title.trim().to_string(), bot_ids: st.members.clone() };
            st.busy = true;
            let answer =
                |r: Result<Conversation, crate::core::api::ApiError>| m(Msg::GroupSaved(r.map_err(|e| e.message)));
            return match s.route {
                Route::Group(Some(id)) => {
                    s.call(
                        move |api| async move {
                            api.patch::<Conversation, _>(&format!("/conversations/{id}"), &change).await
                        },
                        answer,
                    )
                }
                _ => s.call(
                    move |api| async move { api.post::<Conversation, _>("/conversations", &change).await },
                    answer,
                ),
            };
        }
        Msg::GroupSaved(Ok(c)) => {
            st.busy = false;
            let made = !matches!(s.route, Route::Group(Some(_)));
            let id = c.id;
            s.store.put_conversation(c);
            return Task::done(if made {
                Message::Chat(crate::ui::chat::Msg::Open(id))
            } else {
                Message::Toast("Saved.".into())
            });
        }
        Msg::GroupSaved(Err(e)) => {
            st.busy = false;
            st.error = Some(e);
        }
        Msg::DeleteGroup(id) => {
            let name = s.store.chat_name(s.store.conversations.iter().find(|c| c.id == id));
            return confirm::ask(
                format!("Delete {name}?"),
                "Its messages go with it.",
                "Delete",
                m(Msg::DeleteGroupSure(id)),
            );
        }
        Msg::DeleteGroupSure(id) => {
            return Task::batch([
                s.call(
                    move |api| async move { api.delete(&format!("/conversations/{id}")).await },
                    |r| r.err().map(failed).unwrap_or(Message::Nothing),
                ),
                Task::done(Message::Go(Route::Chat)),
            ]);
        }
    }
    Task::none()
}

pub fn view<'a>(s: &'a Session, r: &'a Route) -> Element<'a, Message> {
    let st = &s.pages.bots;
    match r {
        Route::NewBot => {
            let making = st.making.unwrap_or(Making::Bot);
            let tabs = segmented(&[("Bot", Making::Bot), ("Group", Making::Group)], making, |k| m(Msg::Making(k)));
            let body = match making {
                Making::Bot => bot_form(s, None),
                Making::Group => group_form(s, None),
            };
            page(column![tabs, body].spacing(SP_XL))
        }
        Route::Bot(id) => page(bot_form(s, Some(id))),
        Route::Group(id) => page(group_form(s, *id)),
        _ => page(column![]),
    }
}

fn bot_form<'a>(s: &'a Session, id: Option<&'a String>) -> Element<'a, Message> {
    let st = &s.pages.bots;
    let Some(f) = &st.form else { return column![].into() };
    let is_hatbot = id.is_some_and(|i| i == HATBOT);
    let mut col = column![].spacing(SP_XL);
    if let Some(e) = &st.error {
        col = col.push(error(e.as_str()));
    }
    if id.is_none() && !st.templates.is_empty() {
        let mut list = vec![Choice { id: String::new(), name: "None".into() }];
        list.extend(st.templates.iter().map(|t| Choice { id: t.id.clone(), name: t.name.clone() }));
        let sel = list.iter().find(|c| Some(&c.id) == st.template.as_ref()).cloned().or(list.first().cloned());
        col = col.push(card(picker("Template", list, sel, |c| m(Msg::Template(c)))));
    }
    let name = if is_hatbot {
        Element::from(text(f.name.as_str()).size(FS_TEXT))
    } else {
        input("Name", &f.name, |v| m(Msg::Name(v))).into()
    };
    col = col.push(field("Name", name));

    let mut icons_row = row![].spacing(SP);
    for i in BOT_ICONS {
        let lit = f.icon == i;
        icons_row = icons_row.push(
            button(icons::bot(i, &f.color, 24.0, lit))
                .padding(8)
                .style(move |t, st| {
                    let mut b = theme::plain_square(t, st);
                    if lit {
                        b.background = Some(theme::alpha(theme::colors(t).text, 0.12).into());
                    }
                    b.border.radius = R_MD.into();
                    b
                })
                .on_press(m(Msg::Icon(i))),
        );
    }
    col = col.push(section("Icon", icons_row.wrap()));

    let mut colors = row![].spacing(SP);
    for c in BOT_COLORS {
        let lit = f.color == c;
        colors = colors.push(
            button(container(text("")).width(26).height(26).style(move |t| container::Style {
                background: Some(theme::bot_color(t, c).into()),
                border: iced::Border { radius: 13.0.into(), ..Default::default() },
                ..Default::default()
            }))
            .padding(5)
            .style(move |t, _| button::Style {
                border: iced::Border {
                    radius: 20.0.into(),
                    width: if lit { 2.0 } else { 0.0 },
                    color: theme::colors(t).text_2,
                },
                ..Default::default()
            })
            .on_press(m(Msg::Color(c))),
        );
    }
    col = col.push(section("Colour", colors.wrap()));

    let role_ready = id.is_none() || st.base.is_some();
    let mut editor =
        area(&f.role, "Plans the week's meals around what's in the fridge. Keeps the shopping list.", |a| {
            m(Msg::Role(a))
        })
        .min_height(120);
    if !role_ready {
        editor = editor.on_action(|_| Message::Nothing);
    }
    col = col.push(section("Role", editor));

    let defaults = s.settings.as_ref();
    let model_name = |id: &str| {
        st.models.iter().find(|o| o.id == id).map(|o| o.name.clone()).unwrap_or_else(|| format::model_name(id))
    };
    let by_default = |name: Option<String>| name.map(|n| format!("Default ({n})")).unwrap_or_else(|| "Default".into());
    let mut model_list = vec![Choice {
        id: String::new(),
        name: by_default(defaults.and_then(|d| d.chat_model.as_deref()).map(model_name)),
    }];
    model_list.extend(st.models.iter().map(|o| Choice { id: o.id.clone(), name: o.name.clone() }));
    if let Some(cur) = &f.chat_model
        && !model_list.iter().any(|c| &c.id == cur)
    {
        model_list.push(Choice { id: cur.clone(), name: model_name(cur) });
    }
    let model_sel = model_list.iter().find(|c| c.id == f.chat_model.clone().unwrap_or_default()).cloned();
    let effort_name = |e: &str| if e == "xhigh" { "Extra high".to_string() } else { capitalised(e) };
    let mut efforts = vec![Choice {
        id: String::new(),
        name: by_default(defaults.and_then(|d| d.chat_effort.as_deref()).map(effort_name)),
    }];
    efforts.extend(CHAT_EFFORTS.iter().map(|e| Choice { id: e.to_string(), name: effort_name(e) }));
    let effort_sel = efforts.iter().find(|c| c.id == f.chat_effort.clone().unwrap_or_default()).cloned();
    col = col.push(card(
        column![
            picker("Model", model_list, model_sel, |c| m(Msg::Model(c))),
            picker("Effort", efforts, effort_sel, |c| m(Msg::Effort(c)))
        ]
        .spacing(SP_MD),
    ));

    if let Some(plugins) = s.plugins.as_ref().filter(|p| !p.is_empty()) {
        let mut p =
            column![switch_row("Every plugin that's on", None, f.plugins.is_none(), Some(|v| m(Msg::AllPlugins(v))))]
                .spacing(SP_MD);
        if let Some(on) = &f.plugins {
            let mut sorted: Vec<&PluginName> = plugins.iter().collect();
            sorted.sort_by(|a, b| a.name.cmp(&b.name));
            for pl in sorted {
                if pl.enabled {
                    let id = pl.id.clone();
                    p = p.push(switch_row(
                        pl.name.as_str(),
                        None,
                        on.contains(&pl.id),
                        Some(move |v| m(Msg::Plugin(id.clone(), v))),
                    ));
                } else {
                    p = p.push(row![text(pl.name.as_str()).size(FS_TEXT).width(Length::Fill), small("Off in Plugins")]);
                }
            }
        }
        col = col.push(section("Plugins", card(p)));
    }

    let changed = match (&st.base, id) {
        (_, None) => true,
        (Some(b), Some(_)) => !f.same_as(b),
        (None, Some(_)) => false,
    };
    let can_save = !st.busy && changed && !f.name.trim().is_empty() && role_ready;
    let mut actions = row![].spacing(SP).align_y(Alignment::Center);
    if let Some(id) = id.filter(|_| !is_hatbot) {
        let notes = super::link(&format!("memory/bots/{id}/INDEX.md")).unwrap_or_default();
        actions = actions.push(btn("Delete", theme::plain, Some(m(Msg::Delete)))).push(btn(
            "Its notes",
            theme::plain,
            Some(Message::Batch(notes)),
        ));
    }
    actions = actions.push(fill()).push(btn(
        if id.is_none() { "Create" } else { "Save" },
        theme::primary,
        can_save.then_some(m(Msg::Save)),
    ));
    col.push(actions).into()
}

fn group_form(s: &Session, id: Option<i64>) -> Element<'_, Message> {
    let st = &s.pages.bots;
    let stored = id.and_then(|id| s.store.conversations.iter().find(|c| c.id == id));
    let mut col = column![].spacing(SP_XL);
    if let Some(e) = &st.error {
        col = col.push(error(e.as_str()));
    }
    col = col.push(field("Name", input("Name", &st.title, |v| m(Msg::Title(v)))));
    let mut bots = column![].spacing(SP_MD);
    for b in s.store.bot_ids.iter().filter_map(|id| s.store.bots.get(id)) {
        let id = b.id.clone();
        bots = bots.push(
            row![
                icons::bot(&b.icon, &b.color, 22.0, false),
                switch_row(
                    b.name.as_str(),
                    None,
                    st.members.contains(&b.id),
                    Some(move |v| m(Msg::Member(id.clone(), v)))
                )
            ]
            .spacing(SP_MD)
            .align_y(Alignment::Center),
        );
    }
    col = col.push(section("Bots", card(bots)));
    let valid = (2..=MAX_GROUP_BOTS).contains(&st.members.len());
    let changed = stored.is_none_or(|c| st.title.trim() != c.title.as_deref().unwrap_or("") || st.members != c.bot_ids);
    let mut actions = row![].spacing(SP);
    if let Some(id) = id {
        actions = actions.push(btn("Delete group", theme::plain, Some(m(Msg::DeleteGroup(id)))));
    }
    actions = actions.push(fill()).push(btn(
        if id.is_none() { "Create" } else { "Save" },
        theme::primary,
        (!st.busy && valid && changed).then_some(m(Msg::SaveGroup)),
    ));
    col.push(actions).into()
}

fn capitalised(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}
