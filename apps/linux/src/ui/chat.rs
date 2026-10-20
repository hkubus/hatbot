// The open chat (PLAN.md §10.2, §10.4): a column of messages with a time after a pause and the
// finished conversations folded under their recaps, the approvals and questions waiting for you, and
// the composer. Rows are built again only when what they show changes; a reply streaming in updates
// in place.
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::{Rc, Weak};
use std::time::Duration;

use adw::prelude::*;
use gtk::glib;
use hatbot::core::format;
use hatbot::core::models::{ConversationKind, MessageLink, ThreadMessage};
use hatbot::core::thread;
use hatbot::store::{Change, Listener, Store};

use super::composer::Composer;
use super::message::{self, Actions, Item, Live, Look, menu};
use super::tray::Tray;

pub struct Chat {
    pub root: gtk::Widget,
    /// For the header: in or out of incognito.
    pub incognito: gtk::ToggleButton,
    _inner: Rc<Inner>,
    _listener: Listener,
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum Key {
    Time(i64),
    Fold(i64),
    Message(i64),
}

#[derive(PartialEq)]
enum Shows {
    Time(String),
    Fold {
        text: String,
        time: String,
        open: bool,
    },
    Message(Box<Look>),
}

struct Shown {
    key: Key,
    shows: Shows,
    widget: gtk::Widget,
    bubble: Option<gtk::Widget>,
    live: Option<Live>,
}

/// Stuck to the bottom within this, so a reply coming in is followed.
const STICKY: f64 = 60.0;

struct Inner {
    store: Store,
    actions: Actions,
    scroll: gtk::ScrolledWindow,
    list: gtk::Box,
    earlier: adw::Spinner,
    empty: gtk::Label,
    down: gtk::Button,
    tray: Rc<Tray>,
    composer: Rc<Composer>,
    incognito: gtk::ToggleButton,
    shown: RefCell<Vec<Shown>>,
    open_folds: RefCell<HashSet<i64>>,
    /// Which chat the folds and place are for.
    chat: Cell<(i64, bool)>,
    sticky: Cell<bool>,
    /// While an earlier page goes in above: how far from the bottom you were, kept.
    anchor: Cell<Option<f64>>,
    loading_earlier: Cell<bool>,
    replies: RefCell<HashSet<i64>>,
    replies_due: Cell<bool>,
    seen_check: RefCell<Option<glib::SourceId>>,
    syncing: Cell<bool>,
}

impl Chat {
    pub fn new(store: &Store) -> Chat {
        let list = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .margin_start(5)
            .margin_end(14)
            .margin_top(12)
            .margin_bottom(12)
            .build();
        let earlier = adw::Spinner::builder()
            .visible(false)
            .halign(gtk::Align::Center)
            .margin_bottom(8)
            .build();
        list.append(&earlier);
        let empty = gtk::Label::builder()
            .wrap(true)
            .justify(gtk::Justification::Center)
            .margin_top(40)
            .visible(false)
            .css_classes(["dim-label"])
            .build();
        list.append(&empty);
        let clamp = adw::Clamp::builder()
            .maximum_size(720)
            .tightening_threshold(720)
            .child(&list)
            .build();
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vexpand(true)
            .child(&clamp)
            .build();
        let down = gtk::Button::builder()
            .icon_name("go-down-symbolic")
            .tooltip_text("Scroll to Bottom")
            .halign(gtk::Align::Center)
            .valign(gtk::Align::End)
            .margin_bottom(8)
            .visible(false)
            .css_classes(["circular", "osd"])
            .build();
        let overlay = gtk::Overlay::builder().child(&scroll).build();
        overlay.add_overlay(&down);
        let incognito = gtk::ToggleButton::builder()
            .icon_name("view-conceal-symbolic")
            .tooltip_text("Incognito")
            .visible(false)
            .build();

        let inner = Rc::new_cyclic(|weak: &Weak<Inner>| {
            let w = weak.clone();
            let actions = Actions {
                store: store.clone(),
                reveal: Rc::new(move |link| {
                    if let Some(i) = w.upgrade() {
                        i.reveal(link);
                    }
                }),
            };
            let w = weak.clone();
            let composer = Composer::new(store, move || {
                if let Some(i) = w.upgrade() {
                    i.to_bottom();
                }
            });
            Inner {
                store: store.clone(),
                actions,
                scroll,
                list,
                earlier,
                empty,
                down,
                tray: Tray::new(store),
                composer,
                incognito: incognito.clone(),
                shown: RefCell::default(),
                open_folds: RefCell::default(),
                chat: Cell::new((0, false)),
                sticky: Cell::new(true),
                anchor: Cell::new(None),
                loading_earlier: Cell::new(false),
                replies: RefCell::default(),
                replies_due: Cell::new(false),
                seen_check: RefCell::default(),
                syncing: Cell::new(false),
            }
        });

        let bottom = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(6)
            .margin_start(12)
            .margin_end(12)
            .margin_top(6)
            .margin_bottom(10)
            .build();
        bottom.append(&inner.tray.root);
        bottom.append(&inner.composer.root);
        let root = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .build();
        root.append(&overlay);
        root.append(
            &adw::Clamp::builder()
                .maximum_size(744)
                .tightening_threshold(744)
                .child(&bottom)
                .build(),
        );

        let adj = inner.scroll.vadjustment();
        let weak = Rc::downgrade(&inner);
        adj.connect_value_changed(move |_| {
            if let Some(i) = weak.upgrade() {
                i.scrolled();
            }
        });
        let weak = Rc::downgrade(&inner);
        adj.connect_changed(move |adj| {
            let Some(i) = weak.upgrade() else { return };
            i.keep_place(adj);
            // Moved during layout, the viewport keeps drawing the old place until it's laid out again.
            let weak = Rc::downgrade(&i);
            glib::idle_add_local_once(move || {
                if let Some(viewport) = weak.upgrade().and_then(|i| i.scroll.child()) {
                    viewport.queue_allocate();
                }
            });
        });
        let weak = Rc::downgrade(&inner);
        inner.down.connect_clicked(move |_| {
            if let Some(i) = weak.upgrade() {
                i.to_bottom();
            }
        });
        let weak = Rc::downgrade(&inner);
        inner.incognito.connect_toggled(move |b| {
            let Some(i) = weak.upgrade() else { return };
            if i.syncing.get() {
                return;
            }
            let (store, on) = (i.store.clone(), b.is_active());
            glib::spawn_future_local(async move { store.set_incognito(on).await });
        });
        // Seen only with the window in front: check again when it comes to the front.
        let weak = Rc::downgrade(&inner);
        root.connect_realize(move |root| {
            let Some(window) = root.root().and_downcast::<gtk::Window>() else {
                return;
            };
            let weak = weak.clone();
            window.connect_is_active_notify(move |_| {
                if let Some(i) = weak.upgrade() {
                    i.check_seen();
                }
            });
        });

        let weak = Rc::downgrade(&inner);
        let listener = store.listen(move |change| {
            let Some(i) = weak.upgrade() else { return };
            match change {
                Change::Messages
                | Change::Unread
                | Change::Task(_)
                | Change::Schedule(_)
                | Change::Box(_) => i.render(),
                Change::Desktop | Change::Chats => {
                    i.render();
                    i.composer.sync();
                }
                Change::Reply(id) => i.reply_changed(*id),
                Change::NeedsYou => {
                    i.tray.sync();
                    i.render();
                }
                _ => {}
            }
        });
        inner.render();
        Chat {
            root: root.upcast(),
            incognito,
            _inner: inner,
            _listener: listener,
        }
    }
}

impl Inner {
    fn distance(&self) -> f64 {
        let adj = self.scroll.vadjustment();
        adj.upper() - adj.page_size() - adj.value()
    }

    /// At the bottom while it was, or as far from it as before while an earlier page loads.
    fn keep_place(&self, adj: &gtk::Adjustment) {
        if let Some(d) = self.anchor.get() {
            adj.set_value(adj.upper() - adj.page_size() - d);
        } else if self.sticky.get() {
            adj.set_value(adj.upper() - adj.page_size());
        }
    }

    fn to_bottom(&self) {
        self.anchor.set(None);
        self.sticky.set(true);
        let adj = self.scroll.vadjustment();
        adj.set_value(adj.upper() - adj.page_size());
    }

    fn scrolled(self: &Rc<Self>) {
        let d = self.distance();
        if self.anchor.get().is_none() {
            self.sticky.set(d < STICKY);
        }
        self.down.set_visible(d > 400.0);
        if self.scroll.vadjustment().value() < 300.0 {
            self.load_earlier();
        }
        self.check_seen();
    }

    /// Scrolling up to the top loads the page before it, keeping your place.
    fn load_earlier(self: &Rc<Self>) {
        if self.loading_earlier.get() || !self.store.state().has_earlier {
            return;
        }
        self.loading_earlier.set(true);
        self.anchor.set(Some(self.distance()));
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            let Some(store) = weak.upgrade().map(|i| i.store.clone()) else {
                return;
            };
            let _ = store.load_earlier().await;
            // Until the page is laid out.
            glib::timeout_future(Duration::from_millis(500)).await;
            if let Some(i) = weak.upgrade() {
                i.anchor.set(None);
                i.loading_earlier.set(false);
            }
        });
    }

    /// The rows the chat shows now: times, folds, and the messages that aren't folded away.
    fn rows(&self) -> Vec<(Key, Shows)> {
        let st = self.store.state();
        let group = st
            .current_chat()
            .is_some_and(|c| c.kind == ConversationKind::Group);
        let open = self.open_folds.borrow();
        let last = st.messages.last().map(|m| m.id);
        let now = glib::DateTime::now_local().ok();
        enum Pre<'a> {
            Time(i64, String),
            Fold(i64, String, String),
            Message(&'a ThreadMessage),
        }
        let mut pre = vec![];
        let mut previous: Option<glib::DateTime> = None;
        let mut add = |pre: &mut Vec<Pre<'_>>, m: &ThreadMessage| {
            let at = format::date(&m.created_at);
            if let (Some(at), Some(now)) = (&at, &now)
                && let Some(t) = format::pause(at, previous.as_ref(), now)
            {
                pre.push(Pre::Time(m.id, t));
            }
            previous = at.or(previous.take());
        };
        let groups = thread::groups(&st.messages, &st.episodes);
        let index: HashMap<i64, &ThreadMessage> = st.messages.iter().map(|m| (m.id, m)).collect();
        for g in &groups {
            let (Some(fold), Some(id)) = (&g.fold, g.episode_id) else {
                for m in &g.messages {
                    add(&mut pre, m);
                    pre.push(Pre::Message(index[&m.id]));
                }
                continue;
            };
            add(&mut pre, &g.messages[0]);
            pre.push(Pre::Fold(
                id,
                fold.clone(),
                format::time_text(&g.messages[0].created_at),
            ));
            // A message you haven't seen stays in view.
            for m in g
                .messages
                .iter()
                .filter(|m| open.contains(&id) || st.unread.contains(&m.id))
            {
                add(&mut pre, m);
                pre.push(Pre::Message(index[&m.id]));
            }
        }
        let sender = |p: Option<&Pre<'_>>| match p {
            Some(Pre::Message(m)) => message::sender(m),
            _ => None,
        };
        let mut rows = vec![];
        for (i, p) in pre.iter().enumerate() {
            rows.push(match p {
                Pre::Time(id, t) => (Key::Time(*id), Shows::Time(t.clone())),
                Pre::Fold(id, text, time) => (
                    Key::Fold(*id),
                    Shows::Fold {
                        text: text.clone(),
                        time: time.clone(),
                        open: open.contains(id),
                    },
                ),
                Pre::Message(m) => {
                    let joined = i > 0
                        && sender(pre.get(i - 1)).is_some_and(|s| Some(s) == message::sender(m));
                    let look = Look::new(&st, m, joined, group, Some(m.id) == last);
                    (Key::Message(m.id), Shows::Message(Box::new(look)))
                }
            });
        }
        rows
    }

    fn render(self: &Rc<Self>) {
        let (chat, incognito, name, loaded, empty, has_earlier, is_group) = {
            let st = self.store.state();
            let c = st.current_chat();
            (
                st.conversation_id,
                st.incognito,
                st.chat_name(c),
                st.loaded,
                st.messages.is_empty(),
                st.has_earlier,
                c.is_some_and(|c| c.kind == ConversationKind::Group),
            )
        };
        if self.chat.replace((chat, incognito)) != (chat, incognito) {
            self.open_folds.borrow_mut().clear();
            self.sticky.set(true);
            self.anchor.set(None);
            self.composer.sync();
            self.composer.focus();
        }
        self.syncing.set(true);
        self.incognito.set_visible(!is_group);
        self.incognito.set_active(incognito);
        self.incognito.set_tooltip_text(Some(if incognito {
            "Leave Incognito"
        } else {
            "Incognito"
        }));
        self.syncing.set(false);
        self.earlier.set_visible(has_earlier);
        self.empty.set_label(&if incognito {
            format!("{name} can't see earlier conversations here, and this one is deleted when you leave.")
        } else {
            format!("Say hello to {name}.")
        });
        self.empty.set_visible(loaded && empty);

        let rows = self.rows();
        let mut old: HashMap<Key, Shown> = self
            .shown
            .borrow_mut()
            .drain(..)
            .map(|s| (s.key.clone(), s))
            .collect();
        let mut shown = Vec::with_capacity(rows.len());
        let mut prev: gtk::Widget = self.empty.clone().upcast();
        for (key, shows) in rows {
            let s = match old.remove(&key) {
                Some(s) if s.shows == shows => s,
                Some(s) => {
                    self.list.remove(&s.widget);
                    self.build(key, shows)
                }
                None => self.build(key, shows),
            };
            if s.widget.parent().is_none() {
                self.list.insert_child_after(&s.widget, Some(&prev));
            } else {
                self.list.reorder_child_after(&s.widget, Some(&prev));
            }
            prev = s.widget.clone();
            shown.push(s);
        }
        for s in old.into_values() {
            self.list.remove(&s.widget);
        }
        let st = self.store.state();
        for s in &shown {
            if let (Key::Message(id), Some(b)) = (&s.key, &s.bubble) {
                if st.unread.contains(id) {
                    b.add_css_class("unread");
                } else {
                    b.remove_css_class("unread");
                }
            }
        }
        drop(st);
        self.shown.replace(shown);
        self.check_seen();
    }

    fn build(self: &Rc<Self>, key: Key, shows: Shows) -> Shown {
        let (widget, bubble, live) = match &shows {
            Shows::Time(t) => (
                gtk::Label::builder()
                    .label(t)
                    .margin_top(14)
                    .margin_bottom(4)
                    .css_classes(["caption-heading", "dim-label"])
                    .build()
                    .upcast(),
                None,
                None,
            ),
            Shows::Fold { text, time, open } => {
                let Key::Fold(id) = key else { unreachable!() };
                (self.fold(id, text, time, *open), None, None)
            }
            Shows::Message(look) => {
                let row = message::build(look, &self.actions);
                (row.widget, row.bubble, row.live)
            }
        };
        Shown {
            key,
            shows,
            widget,
            bubble,
            live,
        }
    }

    /// A finished conversation, folded up under its recap; a click opens it in place.
    fn fold(self: &Rc<Self>, id: i64, text: &str, time: &str, open: bool) -> gtk::Widget {
        let line = gtk::Box::builder().spacing(8).build();
        line.append(&gtk::Image::from_icon_name(if open {
            "pan-down-symbolic"
        } else {
            "pan-end-symbolic"
        }));
        line.append(
            &gtk::Label::builder()
                .label(text)
                .xalign(0.0)
                .hexpand(true)
                .wrap(true)
                .build(),
        );
        line.append(
            &gtk::Label::builder()
                .label(time)
                .css_classes(["caption"])
                .build(),
        );
        let button = gtk::Button::builder()
            .child(&line)
            .margin_top(10)
            .css_classes(["flat", "fold", "dim-label"])
            .build();
        button.update_property(&[gtk::accessible::Property::Description(if open {
            "Folds the conversation"
        } else {
            "Shows the conversation"
        })]);
        let weak = Rc::downgrade(self);
        button.connect_clicked(move |_| {
            let Some(i) = weak.upgrade() else { return };
            {
                let mut open = i.open_folds.borrow_mut();
                if !open.remove(&id) {
                    open.insert(id);
                }
            }
            i.render();
        });
        let weak = Rc::downgrade(self);
        menu(
            &button,
            vec![Item {
                label: "Delete Conversation".into(),
                run: Box::new(move || {
                    if let Some(i) = weak.upgrade() {
                        i.confirm_delete(id);
                    }
                }),
            }],
        );
        button.upcast()
    }

    fn confirm_delete(self: &Rc<Self>, id: i64) {
        let name = {
            let st = self.store.state();
            st.chat_name(st.current_chat())
        };
        let dialog = adw::AlertDialog::new(
            Some(&format!(
                "Delete this conversation for good? {name} forgets it too."
            )),
            None,
        );
        dialog.add_responses(&[("cancel", "Cancel"), ("delete", "Delete")]);
        dialog.set_response_appearance("delete", adw::ResponseAppearance::Destructive);
        dialog.set_close_response("cancel");
        let store = self.store.clone();
        dialog.connect_response(Some("delete"), move |_, _| {
            let store = store.clone();
            glib::spawn_future_local(async move {
                if let Err(e) = store.delete_episode(id).await {
                    store.toast(&e.message);
                }
            });
        });
        dialog.present(Some(&self.list));
    }

    /// A streaming reply changed: drawn at most ten times a second, as its Markdown is read again.
    fn reply_changed(self: &Rc<Self>, id: i64) {
        self.replies.borrow_mut().insert(id);
        if self.replies_due.replace(true) {
            return;
        }
        let weak = Rc::downgrade(self);
        glib::timeout_add_local_once(Duration::from_millis(100), move || {
            let Some(i) = weak.upgrade() else { return };
            i.replies_due.set(false);
            let ids: Vec<i64> = i.replies.borrow_mut().drain().collect();
            let st = i.store.state();
            for s in i.shown.borrow().iter() {
                if let (Key::Message(id), Some(live)) = (&s.key, &s.live)
                    && ids.contains(id)
                {
                    live.update(&st, *id);
                }
            }
        });
    }

    /// The unread messages on screen enough to count: half of one, or most of the screen for one too
    /// long for that, or its end in view.
    fn on_screen(&self) -> HashSet<i64> {
        let window_active = self
            .scroll
            .root()
            .and_downcast::<gtk::Window>()
            .is_some_and(|w| w.is_active());
        if !window_active || !self.scroll.is_mapped() {
            return HashSet::new();
        }
        let screen = self.scroll.height() as f32;
        let st = self.store.state();
        self.shown
            .borrow()
            .iter()
            .filter_map(|s| {
                let (Key::Message(id), Some(b)) = (&s.key, &s.bubble) else {
                    return None;
                };
                if !st.unread.contains(id) {
                    return None;
                }
                let r = b.compute_bounds(&self.scroll)?;
                let (top, bottom) = (r.y(), r.y() + r.height());
                let shown = bottom.min(screen) - top.max(0.0);
                let seen = shown > 0.0
                    && (shown >= r.height() * 0.5
                        || shown >= screen * 0.6
                        || (bottom > 0.0 && bottom <= screen));
                seen.then_some(*id)
            })
            .collect()
    }

    /// On screen for a moment with the window in front: seen.
    fn check_seen(self: &Rc<Self>) {
        if let Some(c) = self.seen_check.take() {
            c.remove();
        }
        let first = self.on_screen();
        if first.is_empty() {
            return;
        }
        let weak = Rc::downgrade(self);
        let id = glib::timeout_add_local_once(Duration::from_millis(1500), move || {
            let Some(i) = weak.upgrade() else { return };
            i.seen_check.take();
            let ids: Vec<i64> = i.on_screen().intersection(&first).copied().collect();
            if !ids.is_empty() {
                i.store.mark_seen(&ids);
            }
        });
        self.seen_check.replace(Some(id));
    }

    /// That chat, then the message in it, unfolded and in the middle.
    fn reveal(self: &Rc<Self>, link: MessageLink) {
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            let Some(store) = weak.upgrade().map(|i| i.store.clone()) else {
                return;
            };
            let known = store
                .state()
                .conversations
                .iter()
                .any(|c| c.id == link.conversation_id);
            if known {
                store.open_conversation(link.conversation_id).await;
            }
            let found = store.reveal(link.message_id).await;
            let Some(i) = weak.upgrade() else { return };
            let episode = {
                let st = store.state();
                st.messages
                    .iter()
                    .find(|m| m.id == link.message_id)
                    .map(|m| m.episode_id)
            };
            let Some(episode) = episode.filter(|_| found) else {
                store.toast("That message isn't in this chat any more.");
                return;
            };
            if let Some(e) = episode {
                i.open_folds.borrow_mut().insert(e);
            }
            i.render();
            i.sticky.set(false);
            // Once its row is laid out.
            let weak = Rc::downgrade(&i);
            i.list.add_tick_callback(move |_, _| {
                let Some(i) = weak.upgrade() else {
                    return glib::ControlFlow::Break;
                };
                let widget = i
                    .shown
                    .borrow()
                    .iter()
                    .find(|s| s.key == Key::Message(link.message_id))
                    .map(|s| s.widget.clone());
                if let Some(w) = widget
                    && let Some(r) = w.compute_bounds(&i.list)
                {
                    let adj = i.scroll.vadjustment();
                    adj.set_value(r.y() as f64 + r.height() as f64 / 2.0 - adj.page_size() / 2.0);
                }
                glib::ControlFlow::Break
            });
        });
    }
}
