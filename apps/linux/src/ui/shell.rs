// Signed in: the sidebar with your chats and the sections, beside what's open (PLAN.md §23.1).
// Narrow, it's one pane at a time. A task opens over whatever you're on.
use std::any::Any;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use adw::prelude::*;
use gtk::{gio, glib};
use hatbot::core::links::Link;
use hatbot::core::models::{Conversation, ConversationKind, HATBOT_ID};
use hatbot::store::{Change, Listener, Store};

use super::bot::{BotPage, GroupPage};
use super::boxes::{BoxPage, Boxes};
use super::chat::Chat;
use super::icon::Icon;
use super::live::LiveView;
use super::looking::WatcherPage;
use super::memory::{FilePage, Memory};
use super::route;
use super::schedules::{SchedulePage, Schedules};
use super::search::Search;
use super::settings::Settings;
use super::task::TaskPage;
use super::tasks::Tasks;
use super::todo::Todos;
use super::trigger::TriggerPage;

pub struct Shell {
    pub root: gtk::Widget,
    _chat: Chat,
    _inner: Rc<Inner>,
    _listener: Listener,
}

/// What a sidebar row opens.
#[derive(Clone, PartialEq)]
enum Place {
    Chat(i64),
    Search,
    Tasks,
    Todo,
    Boxes,
    Live,
    Schedules,
    Memory,
    Settings,
}

/// "All activity is paused." and "Can't reach Hatbot." over each section.
pub struct Banners {
    store: Store,
    shown: RefCell<Vec<(adw::Banner, adw::Banner)>>,
}

impl Banners {
    pub fn add(&self, view: &adw::ToolbarView) {
        let paused = adw::Banner::builder()
            .title("All activity is paused.")
            .button_label("Resume")
            .build();
        let store = self.store.clone();
        paused.connect_button_clicked(move |_| {
            let store = store.clone();
            glib::spawn_future_local(async move {
                let _ = store.set_paused(false).await;
            });
        });
        let unreachable = adw::Banner::new("Can't reach Hatbot.");
        view.add_top_bar(&paused);
        view.add_top_bar(&unreachable);
        self.shown.borrow_mut().push((paused, unreachable));
        self.sync();
    }

    fn sync(&self) {
        let st = self.store.state();
        for (paused, unreachable) in self.shown.borrow().iter() {
            paused.set_revealed(st.paused);
            unreachable.set_revealed(st.unreachable);
        }
    }
}

struct Inner {
    store: Store,
    split: adw::NavigationSplitView,
    sidebar: gtk::ListBox,
    rows: RefCell<Vec<(Place, gtk::ListBoxRow)>>,
    /// New bot and New group, which open a page over what's showing.
    new_rows: RefCell<Vec<(gtk::ListBoxRow, bool)>>,
    about: gtk::Button,
    nav: adw::NavigationView,
    chat_page: adw::NavigationPage,
    tasks: RefCell<Option<Tasks>>,
    live: RefCell<Option<(adw::NavigationPage, LiveView)>>,
    schedules: RefCell<Option<Schedules>>,
    memory: RefCell<Option<Memory>>,
    search: RefCell<Option<Search>>,
    todo: RefCell<Option<Todos>>,
    boxes: RefCell<Option<Boxes>>,
    settings: RefCell<Option<Settings>>,
    /// The pages opened over a section, with what drives each, kept while they're in `nav`.
    pushed: RefCell<Vec<(adw::NavigationPage, Box<dyn Any>)>>,
    place: RefCell<Place>,
    banners: Banners,
    /// Rebuilding the rows mustn't open what they select.
    syncing: Cell<bool>,
}

impl Shell {
    pub fn new(store: &Store, menu: &gio::Menu) -> Shell {
        let sidebar = gtk::ListBox::builder()
            .css_classes(["navigation-sidebar"])
            .build();
        // The sections under the chats, with a line between.
        sidebar.set_header_func(|row, _| {
            row.set_header(
                (row.widget_name() == "sections")
                    .then(|| gtk::Separator::new(gtk::Orientation::Horizontal))
                    .as_ref(),
            );
        });
        let sidebar_scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vexpand(true)
            .child(&sidebar)
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
        let sidebar_page = adw::NavigationPage::builder()
            .title("Hatbot")
            .child(&sidebar_view)
            .build();

        let banners = Banners {
            store: store.clone(),
            shown: RefCell::default(),
        };
        let chat = Chat::new(store);
        let chat_header = adw::HeaderBar::new();
        chat_header.pack_end(&chat.incognito);
        let about = gtk::Button::builder()
            .child(&Icon::new("sliders", 16))
            .css_classes(["flat"])
            .build();
        chat_header.pack_end(&about);
        let chat_view = adw::ToolbarView::new();
        chat_view.add_top_bar(&chat_header);
        banners.add(&chat_view);
        chat_view.set_content(Some(&chat.root));
        let chat_page = adw::NavigationPage::builder()
            .title("Hatbot")
            .tag("chat")
            .child(&chat_view)
            .build();
        let nav = adw::NavigationView::new();
        nav.add(&chat_page);
        let content = adw::NavigationPage::builder()
            .title("Hatbot")
            .child(&nav)
            .build();

        let split = adw::NavigationSplitView::builder()
            .sidebar(&sidebar_page)
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
            sidebar,
            rows: RefCell::default(),
            new_rows: RefCell::default(),
            about: about.clone(),
            nav,
            chat_page,
            tasks: RefCell::default(),
            live: RefCell::default(),
            schedules: RefCell::default(),
            memory: RefCell::default(),
            search: RefCell::default(),
            todo: RefCell::default(),
            boxes: RefCell::default(),
            settings: RefCell::default(),
            pushed: RefCell::default(),
            place: RefCell::new(Place::Chat(store.state().conversation_id)),
            banners,
            syncing: Cell::default(),
        });

        let weak = Rc::downgrade(&inner);
        inner.sidebar.connect_row_selected(move |_, row| {
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
        inner.sidebar.connect_row_activated(move |_, row| {
            let Some(s) = weak.upgrade() else { return };
            let group = s
                .new_rows
                .borrow()
                .iter()
                .find(|(r, _)| r == row)
                .map(|(_, g)| *g);
            match group {
                Some(true) => {
                    let p = GroupPage::new(&s.store, None);
                    s.push(p.page.clone(), Box::new(p));
                }
                Some(false) => {
                    let p = BotPage::new(&s.store, None);
                    s.push(p.page.clone(), Box::new(p));
                }
                None => s.split.set_show_content(true),
            }
        });
        let weak = Rc::downgrade(&inner);
        about.connect_clicked(move |_| {
            let Some(s) = weak.upgrade() else { return };
            let chat = s.store.state().current_chat().cloned();
            match chat {
                Some(c) if c.kind == ConversationKind::Group => {
                    let p = GroupPage::new(&s.store, Some(c.id));
                    s.push(p.page.clone(), Box::new(p));
                }
                c => {
                    let bot = c
                        .and_then(|c| c.bot_ids.first().cloned())
                        .unwrap_or(HATBOT_ID.into());
                    let p = BotPage::new(&s.store, Some(&bot));
                    s.push(p.page.clone(), Box::new(p));
                }
            }
        });
        let weak = Rc::downgrade(&inner);
        route::set_chat(move |id| {
            if let Some(s) = weak.upgrade() {
                s.open(Place::Chat(id));
            }
        });
        let weak = Rc::downgrade(&inner);
        inner.nav.connect_popped(move |_, _| {
            if let Some(s) = weak.upgrade() {
                s.prune();
            }
        });
        let weak = Rc::downgrade(&inner);
        route::set_push(move |page, keep| {
            if let Some(s) = weak.upgrade() {
                s.push(page, keep);
            }
        });
        let (weak, reveal) = (Rc::downgrade(&inner), chat.reveal.clone());
        route::set_reveal(move |link| {
            let (weak, reveal) = (weak.clone(), reveal.clone());
            glib::spawn_future_local(async move {
                let Some(store) = weak.upgrade().map(|s| s.store.clone()) else {
                    return;
                };
                if store.state().incognito {
                    store.set_incognito(false).await;
                }
                let Some(s) = weak.upgrade() else { return };
                s.show(Place::Chat(link.conversation_id), &s.chat_page.clone());
                reveal(link);
            });
        });
        let weak = Rc::downgrade(&inner);
        route::set(move |link| {
            if let Some(s) = weak.upgrade() {
                s.go(link);
            }
        });

        let weak = Rc::downgrade(&inner);
        let listener = store.listen(move |change| {
            let Some(s) = weak.upgrade() else { return };
            match change {
                Change::Chats | Change::Unread | Change::NeedsYou | Change::Desktop => {
                    s.sync_sidebar()
                }
                Change::Paused | Change::Connection => s.banners.sync(),
                Change::Messages => {
                    s.sync_title();
                    s.sync_selection();
                }
                _ => {}
            }
        });
        inner.sync_sidebar();
        // Hatbot's own chat first, once the chats say which that is.
        let store = store.clone();
        glib::spawn_future_local(async move {
            store.load_bots().await;
            let first = store.hatbot_chat();
            store.open_conversation(first).await;
        });
        Shell {
            root: bin.upcast(),
            _chat: chat,
            _inner: inner,
            _listener: listener,
        }
    }
}

impl Inner {
    fn open(&self, place: Place) {
        let page = match &place {
            Place::Chat(id) => {
                let (store, id) = (self.store.clone(), *id);
                glib::spawn_future_local(async move { store.open_conversation(id).await });
                self.chat_page.clone()
            }
            Place::Search => self
                .search
                .borrow_mut()
                .get_or_insert_with(|| Search::new(&self.store, &self.banners))
                .page
                .clone(),
            Place::Todo => self
                .todo
                .borrow_mut()
                .get_or_insert_with(|| Todos::new(&self.store, &self.banners))
                .page
                .clone(),
            Place::Boxes => self
                .boxes
                .borrow_mut()
                .get_or_insert_with(|| Boxes::new(&self.store, &self.banners))
                .page
                .clone(),
            Place::Tasks => self
                .tasks
                .borrow_mut()
                .get_or_insert_with(|| Tasks::new(&self.store, &self.banners))
                .page
                .clone(),
            Place::Live => self
                .live
                .borrow_mut()
                .get_or_insert_with(|| live_page(&self.store, &self.banners))
                .0
                .clone(),
            Place::Schedules => self
                .schedules
                .borrow_mut()
                .get_or_insert_with(|| Schedules::new(&self.store, &self.banners))
                .page
                .clone(),
            Place::Settings => self
                .settings
                .borrow_mut()
                .get_or_insert_with(|| Settings::new(&self.store, &self.banners))
                .page
                .clone(),
            Place::Memory => self
                .memory
                .borrow_mut()
                .get_or_insert_with(|| Memory::new(&self.store, &self.banners))
                .page
                .clone(),
        };
        self.show(place, &page);
    }

    fn show(&self, place: Place, page: &adw::NavigationPage) {
        self.place.replace(place);
        self.nav.replace(std::slice::from_ref(page));
        self.prune();
        self.sync_title();
        self.sync_selection();
        self.split.set_show_content(true);
    }

    fn go(&self, link: Link) {
        match link {
            Link::Task(id) => self.push_task(id),
            Link::Tasks => self.open(Place::Tasks),
            Link::Approval(id) => {
                self.open(Place::Tasks);
                let store = self.store.clone();
                glib::spawn_future_local(async move {
                    if let Ok(a) = store.load_approval(id).await
                        && let Some(task) = a.task_id
                    {
                        route::go(Link::Task(task));
                    }
                });
            }
            Link::New => self.open(Place::Chat(self.store.hatbot_chat())),
            Link::Schedule(id) => {
                self.open(Place::Schedules);
                let p = SchedulePage::new(&self.store, Some(id));
                self.push(p.page.clone(), Box::new(p));
            }
            Link::Trigger(id) => {
                self.open(Place::Schedules);
                let p = TriggerPage::new(&self.store, id);
                self.push(p.page.clone(), Box::new(p));
            }
            Link::Box(id) => {
                self.open(Place::Boxes);
                let p = BoxPage::new(&self.store, id);
                self.push(p.page.clone(), Box::new(p));
            }
            Link::Live => self.open(Place::Live),
            Link::Watcher(id) => {
                let p = WatcherPage::new(&self.store, id);
                self.push(p.page.clone(), Box::new(p));
            }
            Link::Memory(path) => {
                self.open(Place::Memory);
                if !path.is_empty() {
                    let p = FilePage::new(&self.store, &path, false);
                    self.push(p.page.clone(), Box::new(p));
                }
            }
        }
    }

    fn push_task(&self, id: i64) {
        let page = TaskPage::new(&self.store, id);
        self.push(page.page.clone(), Box::new(page));
    }

    fn push(&self, page: adw::NavigationPage, keep: Box<dyn Any>) {
        self.nav.push(&page);
        self.pushed.borrow_mut().push((page, keep));
        self.split.set_show_content(true);
    }

    /// Lets go of the pages that left `nav`.
    fn prune(&self) {
        let stack = self.nav.navigation_stack();
        let open: Vec<adw::NavigationPage> = (0..stack.n_items())
            .filter_map(|i| stack.item(i).and_downcast())
            .collect();
        self.pushed.borrow_mut().retain(|(p, _)| open.contains(p));
    }

    fn sync_title(&self) {
        let st = self.store.state();
        let title = if st.incognito {
            "Incognito".into()
        } else {
            st.chat_name(st.current_chat())
        };
        self.chat_page.set_title(&title);
        self.about.set_tooltip_text(Some(&format!("About {title}")));
        // A brain from before bots has nothing to show.
        self.about
            .set_visible(!st.incognito && !st.conversations.is_empty());
    }

    /// The row of what's open selected, also when a message opened another chat.
    fn sync_selection(&self) {
        let place = match &*self.place.borrow() {
            Place::Chat(_) => Place::Chat(self.store.state().conversation_id),
            p => p.clone(),
        };
        if let Place::Chat(_) = place {
            self.place.replace(place.clone());
        }
        let rows = self.rows.borrow();
        let Some((_, row)) = rows.iter().find(|(p, _)| *p == place) else {
            return;
        };
        if self.sidebar.selected_row().as_ref() != Some(row) {
            self.syncing.set(true);
            self.sidebar.select_row(Some(row));
            self.syncing.set(false);
        }
    }

    /// The chats, each bot's own then groups, with what's unread in each; then the sections.
    fn sync_sidebar(&self) {
        self.syncing.set(true);
        let mut rows = self.rows.borrow_mut();
        for (_, row) in rows.drain(..) {
            self.sidebar.remove(&row);
        }
        for (row, _) in self.new_rows.borrow_mut().drain(..) {
            self.sidebar.remove(&row);
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
            let count = (c.unread > 0).then_some((c.unread as usize, false));
            let row = sidebar_row(icon, &st.chat_name(Some(c)), count);
            self.sidebar.append(&row);
            rows.push((Place::Chat(c.id), row));
        }
        if !st.conversations.is_empty() {
            let mut new_rows = self.new_rows.borrow_mut();
            let bot = sidebar_row(Icon::new("plus", 18), "New bot", None);
            bot.set_selectable(false);
            self.sidebar.append(&bot);
            new_rows.push((bot, false));
            if st.bot_ids.len() > 1 {
                let group = sidebar_row(Icon::new("users", 18), "New group", None);
                group.set_selectable(false);
                self.sidebar.append(&group);
                new_rows.push((group, true));
            }
        }
        let search = sidebar_row(Icon::new("search", 18), "Search", None);
        search.set_widget_name("sections");
        self.sidebar.append(&search);
        rows.push((Place::Search, search));
        let needs_you = st.needs_you();
        let tasks = sidebar_row(
            Icon::new("tasks", 18),
            "Tasks",
            (needs_you > 0).then_some((needs_you, true)),
        );
        self.sidebar.append(&tasks);
        rows.push((Place::Tasks, tasks));
        let todo = sidebar_row(Icon::new("todo", 18), "To-do", None);
        self.sidebar.append(&todo);
        rows.push((Place::Todo, todo));
        let boxes = sidebar_row(Icon::new("box", 18), "Boxes", None);
        self.sidebar.append(&boxes);
        rows.push((Place::Boxes, boxes));
        let live = sidebar_row(Icon::new("monitor", 18), "Live", None);
        self.sidebar.append(&live);
        rows.push((Place::Live, live));
        let schedules = sidebar_row(Icon::new("clock", 18), "Schedules & Triggers", None);
        self.sidebar.append(&schedules);
        rows.push((Place::Schedules, schedules));
        let memory = sidebar_row(Icon::new("book", 18), "Memory", None);
        self.sidebar.append(&memory);
        rows.push((Place::Memory, memory));
        let settings = sidebar_row(Icon::new("sliders", 18), "Settings", None);
        self.sidebar.append(&settings);
        rows.push((Place::Settings, settings));
        drop(st);
        drop(rows);
        self.sync_selection();
        self.sync_title();
        self.syncing.set(false);
    }
}

fn live_page(store: &Store, banners: &Banners) -> (adw::NavigationPage, LiveView) {
    let live = LiveView::new(store, None, true);
    live.root.set_margin_top(12);
    live.root.set_margin_bottom(12);
    live.root.set_margin_start(12);
    live.root.set_margin_end(12);
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    banners.add(&view);
    view.set_content(Some(&live.root));
    let page = adw::NavigationPage::builder()
        .title("Live")
        .tag("live")
        .child(&view)
        .build();
    (page, live)
}

/// An icon, a name and a count; a count of what needs you is blue.
fn sidebar_row(icon: Icon, name: &str, count: Option<(usize, bool)>) -> gtk::ListBoxRow {
    let line = gtk::Box::builder()
        .spacing(10)
        .margin_top(2)
        .margin_bottom(2)
        .build();
    line.append(&icon);
    line.append(
        &gtk::Label::builder()
            .label(name)
            .xalign(0.0)
            .hexpand(true)
            .ellipsize(gtk::pango::EllipsizeMode::End)
            .build(),
    );
    if let Some((n, needs_you)) = count {
        let l = gtk::Label::builder()
            .label(n.to_string())
            .css_classes(["count"])
            .build();
        if needs_you {
            l.add_css_class("needs-you");
        }
        line.append(&l);
    }
    gtk::ListBoxRow::builder().child(&line).build()
}
