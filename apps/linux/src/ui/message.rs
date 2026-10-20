// One message in the chat, as on iOS (PLAN.md §10.2): your bubble on the right, a bot's on the left
// with its task, schedule, box, sources, choices and files; a command's outcome as a quiet line.
use std::cell::RefCell;
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use hatbot::core::format;
use hatbot::core::links::Link;
use hatbot::core::markdown::escape;
use hatbot::core::models::*;
use hatbot::store::{State, Store};

use super::files::message_files;
use super::markdown::{Markdown, copy, label};
use super::route;

/// What opening something from a message does; the chat decides.
#[derive(Clone)]
pub struct Actions {
    pub store: Store,
    /// Shows a message in its chat.
    pub reveal: Rc<dyn Fn(MessageLink)>,
}

/// Everything a row shows but a reply's live text, so the chat builds it again only when this changes.
#[derive(Clone, PartialEq)]
pub struct Look {
    pub m: ThreadMessage,
    pub joined: bool,
    /// The bot's name and colour over the first of its run in a group.
    pub name: Option<(String, String)>,
    /// The latest message: its choices can be picked.
    pub answerable: bool,
    pub task: Option<Task>,
    pub task_note: String,
    pub schedule: Option<Schedule>,
    pub schedule_gone: bool,
    pub app_box: Option<AppBox>,
    pub box_gone: bool,
    /// Who a hand-off is from.
    pub from: String,
    pub link_label: Option<String>,
}

impl Look {
    pub fn new(st: &State, m: &ThreadMessage, joined: bool, group: bool, answerable: bool) -> Look {
        let task = m.task_id.and_then(|id| st.tasks.get(&id)).cloned();
        let task_note = task
            .as_ref()
            .map(|t| {
                let owner = st
                    .desktop
                    .as_ref()
                    .is_some_and(|d| d.control == Control::Owner);
                if owner && t.status == TaskStatus::Running {
                    "Paused while you have control.".into()
                } else {
                    format::task_line(t, st.task_progress.get(&t.id).map(String::as_str))
                }
            })
            .unwrap_or_default();
        let named =
            group && !joined && m.role != Role::User && !is_note(m) && m.kind != MessageKind::Box;
        let name = named.then(|| {
            let color = m
                .bot_id
                .as_ref()
                .and_then(|b| st.bots.get(b))
                .map(|b| b.color.clone())
                .unwrap_or_default();
            (st.bot_name(m.bot_id.as_deref()), color)
        });
        let link_label =
            m.link.map(
                |l| match st.conversations.iter().find(|c| c.id == l.conversation_id) {
                    None => "Open the other chat".to_string(),
                    Some(c) if c.kind == ConversationKind::Group => {
                        format!("Open in {}", st.chat_name(Some(c)))
                    }
                    Some(c) => format!("Open in {}'s chat", st.chat_name(Some(c))),
                },
            );
        Look {
            m: m.clone(),
            joined,
            name,
            answerable,
            task,
            task_note,
            schedule: m.schedule_id.and_then(|id| st.schedules.get(&id)).cloned(),
            schedule_gone: m
                .schedule_id
                .is_some_and(|id| st.deleted_schedules.contains(&id)),
            app_box: m.box_id.and_then(|id| st.boxes.get(&id)).cloned(),
            box_gone: m.box_id.is_some_and(|id| st.deleted_boxes.contains(&id)),
            from: st.bot_name(m.bot_id.as_deref()),
            link_label,
        }
    }

    /// When a task's result changed the message after it was sent. A brain from before doesn't say:
    /// then a reply's task once it ends, or a task card that showed it running.
    fn edited_at(&self) -> Option<&str> {
        if let Some(e) = &self.m.edited_at {
            return Some(e);
        }
        let done = self.task.as_ref()?.finished_at.as_deref()?;
        match self.m.kind {
            MessageKind::Text | MessageKind::Command => Some(done),
            MessageKind::Task if done > self.m.created_at.as_str() => Some(done),
            _ => None,
        }
    }
}

/// A command's outcome: a quiet line rather than a message.
pub fn is_note(m: &ThreadMessage) -> bool {
    m.role == Role::Assistant && m.kind == MessageKind::Command && m.task_id.is_none()
}

/// Who sent it, for runs: a box's notes are the box's, not its bot's.
pub fn sender(m: &ThreadMessage) -> Option<String> {
    if is_note(m) {
        return None;
    }
    Some(match (m.role, m.kind) {
        (Role::User, _) => "owner".into(),
        (_, MessageKind::Box) => format!("box:{}", m.box_id.unwrap_or(0)),
        _ => format!("bot:{}", m.bot_id.as_deref().unwrap_or("")),
    })
}

/// A streaming reply's parts that change as it's written.
pub struct Live {
    md: Markdown,
    dots: gtk::Widget,
    progress: gtk::Label,
    usage: gtk::Label,
    /// Working dots until the first words, unless its task's dots show instead.
    dots_allowed: bool,
}

impl Live {
    pub fn update(&self, st: &State, id: i64) {
        let Some(r) = st.replies.get(&id) else { return };
        self.md.set(&r.text);
        self.md.root.set_visible(!r.text.is_empty());
        self.dots
            .set_visible(r.text.is_empty() && self.dots_allowed);
        let note = format::last_line(&r.progress);
        self.progress.set_label(note.unwrap_or(""));
        self.progress.set_visible(note.is_some());
        if let Some(u) = &r.usage {
            self.usage.set_label(&format!(
                "{} tokens · ${:.3}",
                format::tokens(u.tokens),
                u.cost_usd
            ));
        }
        self.usage.set_visible(r.usage.is_some());
    }
}

pub struct Row {
    pub widget: gtk::Widget,
    /// Where the unread line goes: a bot's bubble and what's under it.
    pub bubble: Option<gtk::Widget>,
    pub live: Option<Live>,
}

pub fn build(look: &Look, act: &Actions) -> Row {
    let m = &look.m;
    if is_note(m) {
        let l = gtk::Label::builder()
            .label(&m.text)
            .wrap(true)
            .justify(gtk::Justification::Center)
            .selectable(true)
            .css_classes(["dim-label", "caption"])
            .margin_top(10)
            .build();
        return Row {
            widget: l.upcast(),
            bubble: None,
            live: None,
        };
    }
    if m.role == Role::User {
        return user(look, act);
    }
    bot(look, act)
}

fn user(look: &Look, act: &Actions) -> Row {
    let m = &look.m;
    let column = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(4)
        .halign(gtk::Align::End)
        .margin_start(56)
        .margin_top(if look.joined { 2 } else { 10 })
        .build();
    if !m.attachments.is_empty() {
        column.append(&message_files(&act.store, &m.attachments, gtk::Align::End));
    }
    if !m.text.is_empty() {
        let l = gtk::Label::builder()
            .label(&m.text)
            .wrap(true)
            .wrap_mode(gtk::pango::WrapMode::WordChar)
            .xalign(0.0)
            .selectable(true)
            .halign(gtk::Align::End)
            .css_classes(["bubble", "mine"])
            .build();
        menu(&l, vec![copy_item(m.text.clone())]);
        column.append(&l);
    }
    Row {
        widget: column.upcast(),
        bubble: None,
        live: None,
    }
}

fn bot(look: &Look, act: &Actions) -> Row {
    let m = &look.m;
    let column = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(3)
        .halign(gtk::Align::Start)
        .margin_end(40)
        .margin_top(if look.joined || look.name.is_some() {
            2
        } else {
            10
        })
        .css_classes(["bot-row"])
        .build();
    let outer = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .build();
    if let Some((name, color)) = &look.name {
        outer.append(
            &gtk::Label::builder()
                .label(name)
                .xalign(0.0)
                .margin_start(14)
                .margin_top(10)
                .css_classes(["caption-heading", &format!("bot-{color}")])
                .build(),
        );
    }
    outer.append(&column);
    let bubble = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(8)
        .css_classes(["bubble", "theirs"])
        .build();
    let live = content(look, act, &bubble);
    if m.kind != MessageKind::Box
        && let Some(id) = m.box_id
        && !look.box_gone
    {
        act.store.ensure_box(id);
        if let Some(b) = &look.app_box {
            bubble.append(&box_result(b));
        }
    }
    if m.status != MessageStatus::Streaming && !m.sources.is_empty() {
        bubble.append(&sources(&m.sources));
    }
    if look.answerable && m.status != MessageStatus::Streaming && !m.choices.is_empty() {
        bubble.append(&choices(act, &m.choices));
    }
    if !m.attachments.is_empty() {
        bubble.append(&message_files(
            &act.store,
            &m.attachments,
            gtk::Align::Start,
        ));
    }
    menu(&bubble, menu_items(look, act));
    column.append(&bubble);
    if m.status != MessageStatus::Streaming
        && let Some(at) = look.edited_at()
    {
        column.append(
            &gtk::Label::builder()
                .label(format!("Edited {}", format::time_text(at)))
                .xalign(0.0)
                .margin_start(12)
                .css_classes(["caption", "accent"])
                .build(),
        );
    }
    Row {
        widget: outer.upcast(),
        bubble: Some(column.upcast()),
        live,
    }
}

/// The kind's own part: a task, a schedule, a box's note, a hand-off, or the reply.
fn content(look: &Look, act: &Actions, bubble: &gtk::Box) -> Option<Live> {
    let m = &look.m;
    match m.kind {
        MessageKind::Task if m.task_id.is_some() => {
            act.store.ensure_task(m.task_id.unwrap_or_default());
            if let Some(t) = &look.task {
                task_card(look, t, bubble);
            }
            None
        }
        MessageKind::Schedule if m.schedule_id.is_some() => {
            act.store.ensure_schedule(m.schedule_id.unwrap_or_default());
            if let Some(s) = &look.schedule {
                let when = format::when(s.cron.as_deref(), s.run_at.as_deref());
                let mut chars = when.chars();
                let when: String = chars
                    .next()
                    .map(|c| c.to_lowercase().chain(chars).collect())
                    .unwrap_or_default();
                bubble.append(&label(&format!(
                    "Scheduled <b>{}</b>: {}.",
                    escape(&s.name),
                    escape(&when)
                )));
            } else if look.schedule_gone {
                bubble.append(&label("Made a schedule that's since been deleted."));
            }
            None
        }
        MessageKind::Box => {
            if let Some(id) = m.box_id {
                act.store.ensure_box(id);
            }
            let title = look.app_box.as_ref().map_or("a box", |b| b.title.as_str());
            // As written, never Markdown: nobody read what the page sends.
            bubble.append(&label(&format!(
                "<b>From {}:</b> {}",
                escape(title),
                escape(&m.text)
            )));
            None
        }
        MessageKind::Handoff => {
            bubble.append(&label(&format!("<b>From {}:</b>", escape(&look.from))));
            bubble.append(&Markdown::new(&m.text).root);
            if let (Some(link), Some(text)) = (m.link, &look.link_label) {
                let b = gtk::Button::builder()
                    .label(text)
                    .halign(gtk::Align::Start)
                    .css_classes(["pill", "small"])
                    .build();
                let reveal = act.reveal.clone();
                b.connect_clicked(move |_| reveal(link));
                bubble.append(&b);
            } else if let Some(id) = m.task_id {
                let b = gtk::Button::builder()
                    .label("Open Task")
                    .halign(gtk::Align::Start)
                    .css_classes(["pill", "small"])
                    .build();
                b.connect_clicked(move |_| super::route::go(Link::Task(id)));
                bubble.append(&b);
            }
            None
        }
        _ => reply(look, act, bubble),
    }
}

/// A background task as a message: what it's doing, then how it ended.
fn task_card(look: &Look, t: &Task, bubble: &gtk::Box) {
    let title = format!("<b>{}</b>", escape(&t.title));
    let (text, result) = match t.status {
        _ if t.status.is_active() => (title, None),
        TaskStatus::Done => (
            title,
            Some(t.summary.clone().unwrap_or_else(|| "Done.".into())),
        ),
        TaskStatus::Failed => (format!("{title} didn't finish."), t.summary.clone()),
        _ => (format!("{title} was cancelled."), None),
    };
    bubble.append(&label(&text));
    if let Some(r) = result {
        bubble.append(&Markdown::new(&r).root);
    }
    if t.status.is_active() {
        bubble.append(&note(&look.task_note));
    }
}

fn ended(t: &Task) -> bool {
    !t.status.is_active() && t.status != TaskStatus::Cancelled
}

/// The task ended and its bot didn't write the reply again: told some other way, or it failed to.
fn shows_result(m: &ThreadMessage, t: &Task) -> bool {
    ended(t)
        && m.status != MessageStatus::Streaming
        && (m.status == MessageStatus::Error || m.text.is_empty())
}

/// A reply, with the task it started (if any) working under it; the task's result in the reply's place
/// if its bot didn't write it again.
fn reply(look: &Look, act: &Actions, bubble: &gtk::Box) -> Option<Live> {
    let m = &look.m;
    if let Some(id) = m.task_id {
        act.store.ensure_task(id);
    }
    let task = look.task.as_ref();
    let done = task.is_some_and(ended);
    if let Some(t) = task
        && shows_result(m, t)
    {
        task_result(look, t, bubble);
        if !m.text.is_empty() {
            bubble.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
            bubble.append(&Markdown::new(&m.text).root);
        }
        return None;
    }
    let mut live = None;
    if m.status == MessageStatus::Streaming {
        let parts = Live {
            md: Markdown::new(""),
            dots: dots(),
            progress: note(""),
            usage: note(""),
            dots_allowed: m.task_id.is_none() || done,
        };
        parts.usage.add_css_class("numeric");
        parts.progress.set_lines(2);
        parts.progress.set_ellipsize(gtk::pango::EllipsizeMode::End);
        bubble.append(&parts.md.root);
        bubble.append(&parts.dots);
        bubble.append(&parts.progress);
        bubble.append(&parts.usage);
        parts.update(&act.store.state(), m.id);
        if !act.store.state().replies.contains_key(&m.id) {
            parts.md.set(&m.text);
            parts.md.root.set_visible(!m.text.is_empty());
            parts
                .dots
                .set_visible(m.text.is_empty() && parts.dots_allowed);
            parts.progress.set_visible(false);
            parts.usage.set_visible(false);
        }
        live = Some(parts);
    } else if !m.text.is_empty() {
        bubble.append(&Markdown::new(&m.text).root);
    }
    if !done && let Some(t) = task {
        if !m.text.is_empty() && !t.status.is_active() {
            bubble.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        }
        task_result(look, t, bubble);
    }
    live
}

/// A task under the reply that started it: working dots, then how it ended.
fn task_result(look: &Look, t: &Task, bubble: &gtk::Box) {
    if t.status.is_active() {
        bubble.append(&dots());
        if look.task_note != "Working…" {
            bubble.append(&note(&look.task_note));
        }
    } else if t.status == TaskStatus::Done {
        bubble.append(&Markdown::new(t.summary.as_deref().unwrap_or("Done.")).root);
    } else if t.status == TaskStatus::Failed {
        let text = format!("**Didn't finish.** {}", t.summary.as_deref().unwrap_or(""));
        bubble.append(&Markdown::new(&text).root);
    } else {
        let l = label("Cancelled.");
        l.add_css_class("dim-label");
        bubble.append(&l);
    }
}

fn box_result(b: &AppBox) -> gtk::Widget {
    let line = gtk::Box::builder().spacing(10).build();
    line.append(&gtk::Image::from_icon_name("package-x-generic-symbolic"));
    line.append(
        &gtk::Label::builder()
            .label(&b.title)
            .xalign(0.0)
            .hexpand(true)
            .wrap(true)
            .lines(2)
            .ellipsize(gtk::pango::EllipsizeMode::End)
            .css_classes(["heading"])
            .build(),
    );
    let open = gtk::Button::builder()
        .label("Open")
        .valign(gtk::Align::Center)
        .css_classes(["pill", "small"])
        .build();
    let id = b.id;
    open.connect_clicked(move |_| route::go(Link::Box(id)));
    line.append(&open);
    line.upcast()
}

/// The pages a reply cites, in a line of links.
fn sources(list: &[Source]) -> gtk::Widget {
    let links: Vec<String> = list
        .iter()
        .map(|s| {
            let title = if s.title.chars().count() > 60 {
                format!("{}…", s.title.chars().take(59).collect::<String>())
            } else {
                s.title.clone()
            };
            if hatbot::core::markdown::opens(&s.url) {
                format!("<a href=\"{}\">{}</a>", escape(&s.url), escape(&title))
            } else {
                escape(&title)
            }
        })
        .collect();
    let l = label(&format!("Sources: {}", links.join(" · ")));
    l.add_css_class("caption");
    l.add_css_class("dim-label");
    l.upcast()
}

/// The answers the questions at the end of a reply offer. For one, a click sends it as your
/// message; for several, you pick or write each answer and send them together, numbered.
fn choices(act: &Actions, lists: &[Vec<String>]) -> gtk::Widget {
    let column = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(6)
        .build();
    let error = gtk::Label::builder()
        .xalign(0.0)
        .wrap(true)
        .visible(false)
        .css_classes(["caption", "error"])
        .build();
    let send = {
        let (store, column, error) = (act.store.clone(), column.downgrade(), error.downgrade());
        move |text: String| {
            let (store, column, error) = (store.clone(), column.clone(), error.clone());
            if let Some(c) = column.upgrade() {
                c.set_sensitive(false);
            }
            glib::spawn_future_local(async move {
                let client = glib::uuid_string_random();
                if let Err(e) = store.send(&text, &[], &client).await
                    && let (Some(c), Some(l)) = (column.upgrade(), error.upgrade())
                {
                    c.set_sensitive(true);
                    l.set_label(&e.message);
                    l.set_visible(true);
                }
            });
        }
    };
    if let [one] = lists {
        for c in one {
            let b = gtk::Button::builder()
                .label(c)
                .halign(gtk::Align::Start)
                .css_classes(["pill", "small"])
                .build();
            let (send, c) = (send.clone(), c.clone());
            b.connect_clicked(move |_| send(c.clone()));
            column.append(&b);
        }
    } else {
        let answers = Rc::new(RefCell::new(vec![String::new(); lists.len()]));
        let send_button = gtk::Button::builder()
            .label("Send")
            .halign(gtk::Align::Start)
            .sensitive(false)
            .css_classes(["pill", "small", "suggested-action"])
            .build();
        let refresh = {
            let (answers, b) = (answers.clone(), send_button.downgrade());
            move || {
                if let Some(b) = b.upgrade() {
                    b.set_sensitive(answers.borrow().iter().all(|a| !a.trim().is_empty()));
                }
            }
        };
        for (i, list) in lists.iter().enumerate() {
            column.append(
                &gtk::Label::builder()
                    .label(format!("{}.", i + 1))
                    .xalign(0.0)
                    .css_classes(["dim-label", "numeric"])
                    .build(),
            );
            if list.is_empty() {
                let entry = gtk::Entry::builder()
                    .placeholder_text(format!("Answer {}", i + 1))
                    .build();
                let (answers, refresh) = (answers.clone(), refresh.clone());
                entry.connect_changed(move |e| {
                    answers.borrow_mut()[i] = e.text().to_string();
                    refresh();
                });
                column.append(&entry);
                continue;
            }
            let buttons: Rc<RefCell<Vec<gtk::ToggleButton>>> = Rc::default();
            for c in list {
                let b = gtk::ToggleButton::builder()
                    .label(c)
                    .halign(gtk::Align::Start)
                    .css_classes(["pill", "small"])
                    .build();
                if let Some(first) = buttons.borrow().first() {
                    b.set_group(Some(first));
                }
                let (answers, refresh, c) = (answers.clone(), refresh.clone(), c.clone());
                b.connect_toggled(move |b| {
                    if b.is_active() {
                        answers.borrow_mut()[i] = c.clone();
                        refresh();
                    }
                });
                buttons.borrow_mut().push(b.clone());
                column.append(&b);
            }
        }
        let send = send.clone();
        send_button.connect_clicked(move |_| {
            let text = answers
                .borrow()
                .iter()
                .enumerate()
                .map(|(i, a)| format!("{}. {}", i + 1, a.trim()))
                .collect::<Vec<_>>()
                .join("\n");
            send(text);
        });
        column.append(&send_button);
    }
    column.append(&error);
    column.upcast()
}

pub fn note(text: &str) -> gtk::Label {
    gtk::Label::builder()
        .label(text)
        .xalign(0.0)
        .wrap(true)
        .visible(!text.is_empty())
        .css_classes(["caption", "dim-label"])
        .build()
}

/// Three dots that pulse while it works.
pub fn dots() -> gtk::Widget {
    let line = gtk::Box::builder()
        .spacing(4)
        .halign(gtk::Align::Start)
        .css_classes(["typing"])
        .build();
    for _ in 0..3 {
        line.append(
            &gtk::Box::builder()
                .css_classes(["dot"])
                .valign(gtk::Align::Center)
                .build(),
        );
    }
    line.update_property(&[gtk::accessible::Property::Label("Working")]);
    line.upcast()
}

pub struct Item {
    pub label: String,
    pub run: Box<dyn Fn()>,
}

fn copy_item(text: String) -> Item {
    Item {
        label: "Copy".into(),
        run: Box::new(move || copy(&text)),
    }
}

/// What Copy copies, and what Open opens.
fn menu_items(look: &Look, act: &Actions) -> Vec<Item> {
    let m = &look.m;
    let mut items = vec![];
    match m.kind {
        MessageKind::Schedule => {
            if let Some(s) = &look.schedule {
                items.push(copy_item(s.prompt.clone()));
            }
        }
        MessageKind::Box => {
            items.push(copy_item(m.text.clone()));
            if let Some(b) = &look.app_box {
                items.push(open_box_item(b.id));
            }
        }
        MessageKind::Handoff => {
            items.push(copy_item(m.text.clone()));
            if let Some(link) = m.link {
                items.push(link_item(look, act, link));
            }
        }
        _ => {
            let task = look.task.as_ref();
            let result =
                task.and_then(|t| (!t.status.is_active()).then(|| t.summary.clone()).flatten());
            if m.kind == MessageKind::Task {
                if let Some(t) = task {
                    items.push(copy_item(result.unwrap_or_else(|| t.title.clone())));
                }
            } else if task.is_some_and(|t| shows_result(m, t)) {
                items.push(copy_item(result.unwrap_or_default()));
            } else {
                items.push(copy_item(m.text.clone()));
            }
            if let Some(id) = m.box_id {
                items.push(open_box_item(id));
            }
            if let Some(link) = m.link {
                items.push(link_item(look, act, link));
            }
            if let Some(id) = m.task_id {
                items.push(Item {
                    label: "Open Task".into(),
                    run: Box::new(move || super::route::go(Link::Task(id))),
                });
            }
            if m.status == MessageStatus::Error && m.role == Role::Assistant {
                let (store, id) = (act.store.clone(), m.id);
                items.push(Item {
                    label: "Try Again".into(),
                    run: Box::new(move || {
                        let store = store.clone();
                        glib::spawn_future_local(async move {
                            match store.retry(id).await {
                                Err(e) if e.status == 409 => {
                                    store.toast("Only the latest reply can be tried again.")
                                }
                                Err(e) => store.toast(&e.message),
                                Ok(()) => {}
                            }
                        });
                    }),
                });
            }
        }
    }
    items
}

fn open_box_item(id: i64) -> Item {
    Item {
        label: "Open Box".into(),
        run: Box::new(move || route::go(Link::Box(id))),
    }
}

fn link_item(look: &Look, act: &Actions, link: MessageLink) -> Item {
    let reveal = act.reveal.clone();
    Item {
        label: look.link_label.clone().unwrap_or_default(),
        run: Box::new(move || reveal(link)),
    }
}

/// A right click, or a long press, opens the message's menu.
pub fn menu(widget: &impl IsA<gtk::Widget>, items: Vec<Item>) {
    if items.is_empty() {
        return;
    }
    let items = Rc::new(items);
    let show = {
        let widget = widget.as_ref().downgrade();
        move |x: f64, y: f64| {
            let Some(w) = widget.upgrade() else { return };
            let column = gtk::Box::builder()
                .orientation(gtk::Orientation::Vertical)
                .build();
            let popover = gtk::Popover::builder()
                .child(&column)
                .has_arrow(false)
                .halign(gtk::Align::Start)
                .css_classes(["menu"])
                .build();
            for (i, item) in items.iter().enumerate() {
                let b = gtk::Button::builder()
                    .label(&item.label)
                    .css_classes(["flat"])
                    .build();
                if let Some(l) = b.child().and_downcast::<gtk::Label>() {
                    l.set_xalign(0.0);
                }
                let (items, p) = (items.clone(), popover.downgrade());
                b.connect_clicked(move |_| {
                    if let Some(p) = p.upgrade() {
                        p.popdown();
                    }
                    (items[i].run)();
                });
                column.append(&b);
            }
            popover.set_parent(&w);
            popover.set_pointing_to(Some(&gtk::gdk::Rectangle::new(x as i32, y as i32, 1, 1)));
            popover.connect_closed(|p| {
                let p = p.clone();
                glib::idle_add_local_once(move || p.unparent());
            });
            popover.popup();
        }
    };
    // Before a label's own menu, which would copy only what's selected.
    let click = gtk::GestureClick::builder()
        .button(gtk::gdk::BUTTON_SECONDARY)
        .propagation_phase(gtk::PropagationPhase::Capture)
        .build();
    let s = show.clone();
    click.connect_pressed(move |g, _, x, y| {
        g.set_state(gtk::EventSequenceState::Claimed);
        s(x, y);
    });
    widget.add_controller(click);
    let press = gtk::GestureLongPress::builder().touch_only(true).build();
    press.connect_pressed(move |_, x, y| show(x, y));
    widget.add_controller(press);
}
