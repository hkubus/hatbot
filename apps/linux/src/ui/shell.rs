// Signed in: the sidebar with your chats and the sections, beside what's open (PLAN.md §23.1).
// Narrow, it's one pane at a time.
use std::cell::RefCell;
use std::rc::Rc;

use adw::prelude::*;
use gtk::{gio, glib};
use hatbot::core::models::{Conversation, ConversationKind};
use hatbot::store::{Change, Listener, Store};

use super::icon::Icon;

pub struct Shell {
    pub root: gtk::Widget,
    _inner: Rc<Inner>,
    _listener: Listener,
}

/// What a sidebar row opens.
#[derive(Clone, PartialEq)]
enum Place {
    Chat(i64),
}

struct Inner {
    store: Store,
    split: adw::NavigationSplitView,
    chats: gtk::ListBox,
    rows: RefCell<Vec<(Place, gtk::ListBoxRow)>>,
    content: adw::NavigationPage,
    paused: adw::Banner,
    unreachable: adw::Banner,
    /// Rebuilding the rows mustn't open what they select.
    syncing: std::cell::Cell<bool>,
}

impl Shell {
    pub fn new(store: &Store, menu: &gio::Menu) -> Shell {
        let chats = gtk::ListBox::builder()
            .css_classes(["navigation-sidebar"])
            .build();
        let sidebar_scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vexpand(true)
            .child(&chats)
            .build();
        let menu_button = gtk::MenuButton::builder()
            .icon_name("open-menu-symbolic")
            .menu_model(menu)
            .primary(true)
            .tooltip_text("Main Menu")
            .build();
        let sidebar_header = adw::HeaderBar::new();
        sidebar_header.pack_end(&menu_button);
        let sidebar_view = adw::ToolbarView::new();
        sidebar_view.add_top_bar(&sidebar_header);
        sidebar_view.set_content(Some(&sidebar_scroll));
        let sidebar = adw::NavigationPage::builder()
            .title("Hatbot")
            .child(&sidebar_view)
            .build();

        let paused = adw::Banner::builder()
            .title("Hatbot is paused.")
            .button_label("Resume")
            .build();
        let unreachable = adw::Banner::new("Can't reach Hatbot.");
        let content_view = adw::ToolbarView::new();
        content_view.add_top_bar(&adw::HeaderBar::new());
        content_view.add_top_bar(&paused);
        content_view.add_top_bar(&unreachable);
        let content = adw::NavigationPage::builder()
            .title("Hatbot")
            .child(&content_view)
            .build();

        let split = adw::NavigationSplitView::builder()
            .sidebar(&sidebar)
            .content(&content)
            .build();
        let bin = adw::BreakpointBin::builder()
            .width_request(360)
            .height_request(400)
            .child(&split)
            .build();
        let narrow = adw::Breakpoint::new(adw::BreakpointCondition::new_length(
            adw::BreakpointConditionLengthType::MaxWidth,
            640.0,
            adw::LengthUnit::Sp,
        ));
        narrow.add_setter(&split, "collapsed", Some(&true.to_value()));
        bin.add_breakpoint(narrow);

        let inner = Rc::new(Inner {
            store: store.clone(),
            split,
            chats,
            rows: RefCell::default(),
            content,
            paused,
            unreachable,
            syncing: Default::default(),
        });

        let weak = Rc::downgrade(&inner);
        inner.paused.connect_button_clicked(move |_| {
            let Some(s) = weak.upgrade() else { return };
            let store = s.store.clone();
            glib::spawn_future_local(async move {
                let _ = store.set_paused(false).await;
            });
        });
        let weak = Rc::downgrade(&inner);
        inner.chats.connect_row_selected(move |_, row| {
            let (Some(s), Some(row)) = (weak.upgrade(), row) else {
                return;
            };
            if s.syncing.get() {
                return;
            }
            let place = s
                .rows
                .borrow()
                .iter()
                .find(|(_, r)| r == row)
                .map(|(p, _)| p.clone());
            if let Some(place) = place {
                s.open(place);
            }
        });
        // Narrow, picking the row you're on shows it again.
        let weak = Rc::downgrade(&inner);
        inner.chats.connect_row_activated(move |_, _| {
            if let Some(s) = weak.upgrade() {
                s.split.set_show_content(true);
            }
        });

        let weak = Rc::downgrade(&inner);
        let listener = store.listen(move |change| {
            let Some(s) = weak.upgrade() else { return };
            match change {
                Change::Chats | Change::Unread => s.sync_chats(),
                Change::Paused => s.sync_banners(),
                Change::Connection => s.sync_banners(),
                Change::Messages => s.sync_title(),
                _ => {}
            }
        });
        inner.sync_chats();
        inner.sync_banners();
        // Hatbot's own chat first, once the chats say which that is.
        let store = store.clone();
        glib::spawn_future_local(async move {
            store.load_bots().await;
            let first = store.hatbot_chat();
            store.open_conversation(first).await;
        });
        Shell {
            root: bin.upcast(),
            _inner: inner,
            _listener: listener,
        }
    }
}

impl Inner {
    fn open(&self, place: Place) {
        match place {
            Place::Chat(id) => {
                let store = self.store.clone();
                glib::spawn_future_local(async move { store.open_conversation(id).await });
            }
        }
        self.sync_title();
        self.split.set_show_content(true);
    }

    fn sync_title(&self) {
        let st = self.store.state();
        let title = st.chat_name(st.current_chat());
        self.content.set_title(&title);
    }

    fn sync_banners(&self) {
        let st = self.store.state();
        self.paused.set_revealed(st.paused);
        self.unreachable.set_revealed(st.unreachable);
    }

    /// The chats, each bot's own then groups, with what's unread in each.
    fn sync_chats(&self) {
        self.syncing.set(true);
        let mut rows = self.rows.borrow_mut();
        for (_, row) in rows.drain(..) {
            self.chats.remove(&row);
        }
        let st = self.store.state();
        // A brain from before bots has the one chat.
        let list: Vec<Conversation> = if st.conversations.is_empty() {
            vec![Conversation {
                id: st.conversation_id,
                kind: ConversationKind::Direct,
                title: None,
                bot_ids: vec!["hatbot".into()],
                unread: st.unread.len() as i64,
                last_message_at: None,
            }]
        } else {
            st.conversations.clone()
        };
        for c in &list {
            let icon = match (c.kind, c.bot_ids.first().and_then(|b| st.bots.get(b))) {
                (ConversationKind::Direct, Some(bot)) => Icon::bot(&bot.icon, &bot.color, 18),
                (ConversationKind::Direct, None) => Icon::bot("hat", "amber", 18),
                _ => Icon::new("users", 18),
            };
            let name = gtk::Label::builder()
                .label(st.chat_name(Some(c)))
                .xalign(0.0)
                .hexpand(true)
                .ellipsize(gtk::pango::EllipsizeMode::End)
                .build();
            let line = gtk::Box::builder()
                .spacing(10)
                .margin_top(2)
                .margin_bottom(2)
                .build();
            line.append(&icon);
            line.append(&name);
            if c.unread > 0 {
                line.append(
                    &gtk::Label::builder()
                        .label(c.unread.to_string())
                        .css_classes(["count"])
                        .build(),
                );
            }
            let row = gtk::ListBoxRow::builder().child(&line).build();
            self.chats.append(&row);
            if c.id == st.conversation_id {
                self.chats.select_row(Some(&row));
            }
            rows.push((Place::Chat(c.id), row));
        }
        drop(st);
        drop(rows);
        self.sync_title();
        self.syncing.set(false);
    }
}
