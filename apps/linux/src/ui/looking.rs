// Looking after things (PLAN.md §15, LookingViews.swift on iOS): watchers, Check everything and the
// heartbeat, under Settings. Watchers are made and changed in the chat or on the web; here you switch
// them, look now and delete them.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use hatbot::core::format;
use hatbot::core::links::Link;
use hatbot::core::looking;
use hatbot::core::models::{
    CheckReport, CheckState, ChecksInfo, HeartbeatInfo, HeartbeatSettings, Watcher, WatcherValue,
};
use hatbot::store::{Change, Listener, Store};
use serde_json::json;

use super::form::{Choice, TextArea, confirm, error_label, nav_row, note};
use super::route;

fn page_with(
    title: &str,
    header: &adw::HeaderBar,
    prefs: &adw::PreferencesPage,
) -> adw::NavigationPage {
    let view = adw::ToolbarView::new();
    view.add_top_bar(header);
    view.set_content(Some(prefs));
    adw::NavigationPage::builder()
        .title(title)
        .child(&view)
        .build()
}

/// A label and what it is, the value read first.
fn property(title: &str, value: &str) -> adw::ActionRow {
    adw::ActionRow::builder()
        .title(title)
        .subtitle(value)
        .use_markup(false)
        .subtitle_selectable(true)
        .css_classes(["property"])
        .build()
}

/// Groups a page builds again each time it shows something.
#[derive(Default)]
struct Groups(RefCell<Vec<adw::PreferencesGroup>>);

impl Groups {
    fn replace(&self, prefs: &adw::PreferencesPage, groups: Vec<adw::PreferencesGroup>) {
        // Focus left inside a removed group moves to the page's first row,
        // and the page scrolls up to it.
        if let Some(root) = prefs.root()
            && let Some(f) = root.focus()
            && self.0.borrow().iter().any(|g| f.is_ancestor(g))
        {
            root.set_focus(None::<&gtk::Widget>);
        }
        for g in self.0.borrow_mut().drain(..) {
            prefs.remove(&g);
        }
        for g in &groups {
            prefs.add(g);
        }
        self.0.replace(groups);
    }
}

pub struct WatchersPage {
    pub page: adw::NavigationPage,
    _inner: Rc<WatcherList>,
    _listener: Listener,
}

struct WatcherList {
    store: Store,
    prefs: adw::PreferencesPage,
    error: gtk::Label,
    loaded: Cell<bool>,
    groups: Groups,
}

impl WatchersPage {
    pub fn new(store: &Store) -> WatchersPage {
        let error = error_label();
        let top = adw::PreferencesGroup::new();
        top.add(&error);
        let prefs = adw::PreferencesPage::new();
        prefs.add(&top);
        let page = page_with("Watchers", &adw::HeaderBar::new(), &prefs);
        let l = Rc::new(WatcherList {
            store: store.clone(),
            prefs,
            error,
            loaded: Cell::new(false),
            groups: Groups::default(),
        });
        let (weak, s) = (Rc::downgrade(&l), store.clone());
        glib::spawn_future_local(async move {
            let result = s.load_watchers().await;
            let Some(l) = weak.upgrade() else { return };
            l.loaded.set(true);
            if let Err(e) = result {
                l.error.set_label(&e.message);
                l.error.set_visible(true);
            }
            l.render();
        });
        let weak = Rc::downgrade(&l);
        let listener = store.listen(move |change| {
            if let (Some(l), Change::Watchers | Change::Watcher(_)) = (weak.upgrade(), change) {
                l.render();
            }
        });
        WatchersPage {
            page,
            _inner: l,
            _listener: listener,
        }
    }
}

impl WatcherList {
    fn render(&self) {
        if !self.loaded.get() {
            return;
        }
        let group = adw::PreferencesGroup::new();
        let mut list: Vec<Watcher> = self.store.state().watchers.values().cloned().collect();
        list.sort_by_key(|w| w.id);
        if list.is_empty() {
            group.add(&note(
                "No watchers. Ask Hatbot in the chat to watch a page or a value.",
            ));
        }
        for w in &list {
            let row = adw::ActionRow::builder()
                .title(&w.name)
                .subtitle(looking::watcher_line(w))
                .use_markup(false)
                .activatable(true)
                .build();
            if !w.enabled {
                row.add_css_class("dim-label");
            } else if w.last_error.is_some() {
                row.add_css_class("watcher-trouble");
            }
            row.add_suffix(&gtk::Image::from_icon_name("go-next-symbolic"));
            let id = w.id;
            row.connect_activated(move |_| route::go(Link::Watcher(id)));
            group.add(&row);
        }
        self.groups.replace(&self.prefs, vec![group]);
    }
}

/// A watcher: what it looks at, its last look and values.
pub struct WatcherPage {
    pub page: adw::NavigationPage,
    _inner: Rc<WatcherView>,
    _listener: Listener,
}

struct WatcherView {
    store: Store,
    id: i64,
    page: adw::NavigationPage,
    prefs: adw::PreferencesPage,
    error: gtk::Label,
    groups: Groups,
    values: RefCell<Vec<WatcherValue>>,
    /// The look the values were read after, to read them again after the next; None before any.
    checked: RefCell<Option<Option<String>>>,
    looking: Cell<bool>,
    busy: Cell<bool>,
}

impl WatcherPage {
    pub fn new(store: &Store, id: i64) -> WatcherPage {
        let error = error_label();
        let top = adw::PreferencesGroup::new();
        top.add(&error);
        let prefs = adw::PreferencesPage::new();
        prefs.add(&top);
        let page = page_with("Watcher", &adw::HeaderBar::new(), &prefs);
        let w = Rc::new(WatcherView {
            store: store.clone(),
            id,
            page: page.clone(),
            prefs,
            error,
            groups: Groups::default(),
            values: RefCell::default(),
            checked: RefCell::default(),
            looking: Cell::new(false),
            busy: Cell::new(false),
        });
        let (weak, s) = (Rc::downgrade(&w), store.clone());
        glib::spawn_future_local(async move {
            let result = s.load_watcher(id).await;
            if let (Some(w), Err(e)) = (weak.upgrade(), result) {
                w.show_error(&e.message);
            }
        });
        w.render();
        let weak = Rc::downgrade(&w);
        let listener = store.listen(move |change| {
            if let (Some(w), Change::Watcher(id)) = (weak.upgrade(), change)
                && *id == w.id
            {
                w.render();
            }
        });
        WatcherPage {
            page,
            _inner: w,
            _listener: listener,
        }
    }
}

impl WatcherView {
    fn show_error(&self, text: &str) {
        self.error.set_label(text);
        self.error.set_visible(true);
    }

    fn load_values(self: &Rc<Self>) {
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.watcher_values(id).await;
            let Some(w) = weak.upgrade() else { return };
            if let Ok(values) = result {
                w.values.replace(values);
                w.render();
            }
        });
    }

    fn render(self: &Rc<Self>) {
        let (watcher, deleted) = {
            let st = self.store.state();
            (
                st.watchers.get(&self.id).cloned(),
                st.deleted_watchers.contains(&self.id),
            )
        };
        let Some(w) = watcher else {
            if deleted {
                let g = adw::PreferencesGroup::new();
                g.add(&note("This watcher doesn't exist."));
                self.groups.replace(&self.prefs, vec![g]);
            }
            return;
        };
        self.page.set_title(&w.name);
        let look = Some(w.last_checked_at.clone());
        if *self.checked.borrow() != look {
            self.checked.replace(look);
            self.load_values();
        }

        let main = adw::PreferencesGroup::new();
        let on = adw::SwitchRow::builder()
            .title("On")
            .active(w.enabled)
            .sensitive(!self.busy.get())
            .build();
        let weak = Rc::downgrade(self);
        on.connect_active_notify(move |row| {
            if let Some(v) = weak.upgrade() {
                v.update(json!({"enabled": row.is_active()}));
            }
        });
        main.add(&on);
        let page = looking::is_page(&w);
        main.add(&property(
            if page { "Page" } else { "Tool" },
            &looking::source_text(&w),
        ));
        if page {
            let render = adw::SwitchRow::builder()
                .title("Run the page's scripts")
                .active(looking::renders(&w))
                .sensitive(!self.busy.get())
                .build();
            let (weak, w2) = (Rc::downgrade(self), w.clone());
            render.connect_active_notify(move |row| {
                if let Some(v) = weak.upgrade() {
                    v.update(looking::render_change(&w2, row.is_active()));
                }
            });
            main.add(&render);
        }
        for (key, title) in [
            ("selector", "Selector"),
            ("path", "Path"),
            ("pattern", "Pattern"),
        ] {
            if let Some(v) = w.source.get(key).and_then(|v| v.as_str()) {
                let row = property(title, v);
                row.add_css_class("monospace-subtitle");
                main.add(&row);
            }
        }
        main.add(&property("Counts when", &looking::condition(&w.condition)));
        main.add(&property("How often", &looking::every(w.every_minutes)));
        if w.once {
            main.add(&property("Then", "Switches off"));
        }
        main.add(&property(
            "Bot",
            &self.store.state().bot_name(Some(&w.bot_id)),
        ));
        let mut groups = vec![main];

        if !w.prompt.is_empty() {
            let g = adw::PreferencesGroup::builder()
                .title("When it counts")
                .build();
            g.add(
                &gtk::Label::builder()
                    .label(&w.prompt)
                    .xalign(0.0)
                    .wrap(true)
                    .selectable(true)
                    .build(),
            );
            groups.push(g);
        }

        let last = adw::PreferencesGroup::builder().title("Last look").build();
        if let Some(e) = &w.last_error {
            last.add(
                &adw::ActionRow::builder()
                    .title(e)
                    .title_lines(4)
                    .use_markup(false)
                    .css_classes(["error"])
                    .build(),
            );
        }
        if let Some(v) = &w.last_value {
            last.add(
                &adw::ActionRow::builder()
                    .title(v)
                    .title_lines(8)
                    .title_selectable(true)
                    .use_markup(false)
                    .css_classes(["monospace-title"])
                    .build(),
            );
        }
        if let Some(at) = &w.last_checked_at {
            last.add(&property("Looked", &format::stamp(at)));
        }
        if let Some(task) = w.last_task_id {
            last.add(&nav_row("Its last task", move || {
                route::go(Link::Task(task))
            }));
        }
        let look = adw::ButtonRow::builder()
            .title(if self.looking.get() {
                "Looking…"
            } else {
                "Look Now"
            })
            .sensitive(!self.looking.get())
            .build();
        let weak = Rc::downgrade(self);
        look.connect_activated(move |_| {
            if let Some(v) = weak.upgrade() {
                v.look();
            }
        });
        last.add(&look);
        groups.push(last);

        let values = self.values.borrow();
        if !values.is_empty() {
            let g = adw::PreferencesGroup::builder().title("Values").build();
            for v in values.iter() {
                let row = adw::ActionRow::builder()
                    .title(&v.value)
                    .title_lines(3)
                    .subtitle(if v.fired {
                        format!("{}, counted", format::stamp(&v.created_at))
                    } else {
                        format::stamp(&v.created_at)
                    })
                    .use_markup(false)
                    .css_classes(["monospace-title"])
                    .build();
                if v.fired {
                    row.add_css_class("counted");
                }
                g.add(&row);
            }
            groups.push(g);
        }
        drop(values);

        let delete = adw::ButtonRow::builder().title("Delete Watcher").build();
        // Not the builder's css_classes: they would drop the row's own "button".
        delete.add_css_class("destructive-action");
        let (weak, name) = (Rc::downgrade(self), w.name.clone());
        delete.connect_activated(move |row| {
            let weak = weak.clone();
            confirm(row, &format!("Delete “{name}”?"), "Delete", move || {
                if let Some(v) = weak.upgrade() {
                    v.delete();
                }
            });
        });
        let g = adw::PreferencesGroup::new();
        g.add(&delete);
        groups.push(g);
        self.groups.replace(&self.prefs, groups);
    }

    fn update(self: &Rc<Self>, change: serde_json::Value) {
        if self.busy.replace(true) {
            return;
        }
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.update_watcher(id, &change).await;
            let Some(v) = weak.upgrade() else { return };
            v.busy.set(false);
            match result {
                Ok(()) => v.error.set_visible(false),
                Err(e) => v.show_error(&e.message),
            }
            v.render();
        });
    }

    fn look(self: &Rc<Self>) {
        if self.looking.replace(true) {
            return;
        }
        self.render();
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.check_watcher(id).await;
            let Some(v) = weak.upgrade() else { return };
            v.looking.set(false);
            match result {
                Ok(()) => v.error.set_visible(false),
                Err(e) => v.show_error(&e.message),
            }
            v.load_values();
        });
    }

    fn delete(self: &Rc<Self>) {
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.delete_watcher(id).await;
            let Some(v) = weak.upgrade() else { return };
            match result {
                Ok(()) => {
                    let _ = v.page.activate_action("navigation.pop", None);
                }
                Err(e) => v.show_error(&e.message),
            }
        });
    }
}

/// Check everything: a real try of each part Hatbot depends on.
pub struct ChecksPage {
    pub page: adw::NavigationPage,
    _inner: Rc<Checks>,
    _listener: Listener,
}

struct Checks {
    store: Store,
    prefs: adw::PreferencesPage,
    error: gtk::Label,
    check: gtk::Button,
    test: gtk::Button,
    test_row: adw::ActionRow,
    groups: Groups,
    report: RefCell<Option<CheckReport>>,
    approval: Cell<Option<i64>>,
    loaded: Cell<bool>,
    running: Cell<bool>,
}

impl ChecksPage {
    pub fn new(store: &Store) -> ChecksPage {
        let check = gtk::Button::builder()
            .label("Check")
            .css_classes(["suggested-action"])
            .build();
        let header = adw::HeaderBar::new();
        header.pack_end(&check);
        let error = error_label();
        let top = adw::PreferencesGroup::new();
        top.add(&error);
        let phone = adw::PreferencesGroup::builder()
            .title("From your phone")
            .build();
        let test_row = adw::ActionRow::builder().title("Test approval").build();
        let test = gtk::Button::builder()
            .label("Send")
            .valign(gtk::Align::Center)
            .build();
        test_row.add_suffix(&test);
        phone.add(&test_row);
        let prefs = adw::PreferencesPage::new();
        prefs.add(&top);
        prefs.add(&phone);
        let page = page_with("Check everything", &header, &prefs);
        let c = Rc::new(Checks {
            store: store.clone(),
            prefs,
            error,
            check,
            test,
            test_row,
            groups: Groups::default(),
            report: RefCell::default(),
            approval: Cell::new(None),
            loaded: Cell::new(false),
            running: Cell::new(false),
        });
        let weak = Rc::downgrade(&c);
        c.check.connect_clicked(move |_| {
            if let Some(c) = weak.upgrade() {
                c.run();
            }
        });
        let weak = Rc::downgrade(&c);
        c.test.connect_clicked(move |_| {
            if let Some(c) = weak.upgrade() {
                c.send_test();
            }
        });
        let (weak, s) = (Rc::downgrade(&c), store.clone());
        glib::spawn_future_local(async move {
            let result = s.checks().await;
            let Some(c) = weak.upgrade() else { return };
            c.loaded.set(true);
            match result {
                Ok(ChecksInfo { report, approval }) => {
                    if c.report.borrow().is_none() {
                        c.report.replace(report);
                    }
                    if c.approval.get().is_none() {
                        c.approval.set(approval.map(|a| a.id));
                    }
                }
                Err(e) => c.show_error(&e.message),
            }
            c.render();
        });
        c.render();
        let weak = Rc::downgrade(&c);
        let listener = store.listen(move |change| {
            if let (Some(c), Change::NeedsYou) = (weak.upgrade(), change) {
                c.render_answer();
            }
        });
        ChecksPage {
            page,
            _inner: c,
            _listener: listener,
        }
    }
}

impl Checks {
    fn show_error(&self, text: &str) {
        self.error.set_label(text);
        self.error.set_visible(true);
    }

    fn render_answer(&self) {
        let answer = self
            .approval
            .get()
            .and_then(|id| self.store.state().approvals.get(&id).map(looking::answer));
        self.test_row
            .set_subtitle(&glib::markup_escape_text(&answer.unwrap_or_default()));
    }

    fn render(&self) {
        self.render_answer();
        let running = self.running.get();
        self.check
            .set_label(if running { "Checking…" } else { "Check" });
        self.check.set_sensitive(!running);
        let g = adw::PreferencesGroup::new();
        match &*self.report.borrow() {
            Some(r) => {
                g.set_title(&glib::markup_escape_text(&format::stamp(&r.finished_at)));
                for result in &r.results {
                    let row = adw::ActionRow::builder()
                        .title(&result.name)
                        .use_markup(false)
                        .build();
                    if !result.detail.is_empty() {
                        row.set_subtitle(&result.detail);
                    }
                    let (icon, class) = match result.state {
                        CheckState::Ok => ("emblem-ok-symbolic", "success"),
                        CheckState::Warn => ("dialog-warning-symbolic", "warning"),
                        CheckState::Fail => ("process-stop-symbolic", "error"),
                        CheckState::Skip => ("list-remove-symbolic", "dim-label"),
                    };
                    let image = gtk::Image::from_icon_name(icon);
                    image.add_css_class(class);
                    row.add_prefix(&image);
                    g.add(&row);
                }
            }
            None if running || !self.loaded.get() => {
                g.add(&adw::Spinner::builder().height_request(32).build());
            }
            None => g.add(&note("Not run yet.")),
        }
        self.groups.replace(&self.prefs, vec![g]);
    }

    fn run(self: &Rc<Self>) {
        if self.running.replace(true) {
            return;
        }
        self.render();
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.run_checks().await;
            let Some(c) = weak.upgrade() else { return };
            c.running.set(false);
            match result {
                Ok(r) => {
                    c.error.set_visible(false);
                    c.report.replace(Some(r));
                }
                Err(e) => c.show_error(&e.message),
            }
            c.render();
        });
    }

    fn send_test(self: &Rc<Self>) {
        self.test.set_sensitive(false);
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.test_approval().await;
            let Some(c) = weak.upgrade() else { return };
            c.test.set_sensitive(true);
            match result {
                Ok(a) => {
                    c.approval.set(Some(a.id));
                    c.render_answer();
                }
                Err(e) => c.show_error(&e.message),
            }
        });
    }
}

/// The heartbeat: how often it looks, as which bot, what you want done, and what it found.
pub struct HeartbeatPage {
    pub page: adw::NavigationPage,
    _inner: Rc<Heartbeat>,
    _listener: Listener,
}

struct Heartbeat {
    store: Store,
    prefs: adw::PreferencesPage,
    error: gtk::Label,
    on: adw::SwitchRow,
    every: Rc<Choice>,
    bot: Rc<Choice>,
    instructions: TextArea,
    save: gtk::Button,
    groups: Groups,
    settings: RefCell<Option<HeartbeatSettings>>,
    info: RefCell<Option<HeartbeatInfo>>,
    looking: Cell<bool>,
    syncing: Cell<bool>,
}

impl HeartbeatPage {
    pub fn new(store: &Store) -> HeartbeatPage {
        let error = error_label();
        let top = adw::PreferencesGroup::new();
        top.add(&error);
        let main = adw::PreferencesGroup::new();
        let what = adw::PreferencesGroup::builder()
            .title("What you want done")
            .build();
        let instructions = TextArea::new("Restart a monitor that's down once before telling me");
        instructions.root.add_css_class("card");
        let save = gtk::Button::builder()
            .label("Save")
            .halign(gtk::Align::End)
            .margin_top(8)
            .sensitive(false)
            .build();
        what.add(&instructions.root);
        what.add(&save);
        let prefs = adw::PreferencesPage::new();
        prefs.add(&top);
        prefs.add(&main);
        prefs.add(&what);
        let page = page_with("Heartbeat", &adw::HeaderBar::new(), &prefs);

        let h = Rc::new_cyclic(|weak: &std::rc::Weak<Heartbeat>| {
            let w = weak.clone();
            let every = Choice::new("How often", move |v| {
                if let Some(h) = w.upgrade() {
                    let n = v.parse().unwrap_or(30);
                    h.save_with(|s| s.every_minutes = n);
                }
            });
            let w = weak.clone();
            let bot = Choice::new("Bot", move |v| {
                if let Some(h) = w.upgrade() {
                    let v = v.to_string();
                    h.save_with(|s| s.bot_id = v);
                }
            });
            Heartbeat {
                store: store.clone(),
                prefs,
                error,
                on: adw::SwitchRow::builder().title("On").build(),
                every,
                bot,
                instructions,
                save,
                groups: Groups::default(),
                settings: RefCell::default(),
                info: RefCell::default(),
                looking: Cell::new(false),
                syncing: Cell::new(false),
            }
        });
        main.add(&h.on);
        main.add(&h.every.row);
        main.add(&h.bot.row);
        let weak = Rc::downgrade(&h);
        h.on.connect_active_notify(move |row| {
            if let Some(h) = weak.upgrade()
                && !h.syncing.get()
            {
                let on = row.is_active();
                h.save_with(|s| s.enabled = on);
            }
        });
        let weak = Rc::downgrade(&h);
        h.instructions.view.buffer().connect_changed(move |_| {
            if let Some(h) = weak.upgrade() {
                h.sync_save();
            }
        });
        let weak = Rc::downgrade(&h);
        h.save.connect_clicked(move |_| {
            if let Some(h) = weak.upgrade() {
                let text = h.instructions.text().trim().to_string();
                h.save_with(|s| s.instructions = text);
            }
        });
        h.load_settings();
        h.load_info();
        let weak = Rc::downgrade(&h);
        let listener = store.listen(move |change| {
            let Some(h) = weak.upgrade() else { return };
            match change {
                Change::Heartbeat => h.load_info(),
                // Not over what you're writing.
                Change::Settings if !h.instructions.view.has_focus() => h.load_settings(),
                _ => {}
            }
        });
        HeartbeatPage {
            page,
            _inner: h,
            _listener: listener,
        }
    }
}

impl Heartbeat {
    fn show_error(&self, text: &str) {
        self.error.set_label(text);
        self.error.set_visible(true);
    }

    fn load_settings(self: &Rc<Self>) {
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.load_settings().await;
            let Some(h) = weak.upgrade() else { return };
            match result {
                Ok(s) => {
                    h.settings.replace(s.heartbeat);
                    h.render_settings(true);
                }
                Err(e) => h.show_error(&e.message),
            }
        });
    }

    fn load_info(self: &Rc<Self>) {
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.heartbeat().await;
            let Some(h) = weak.upgrade() else { return };
            match result {
                Ok(info) => {
                    h.info.replace(Some(info));
                    h.render_info();
                }
                Err(e) => h.show_error(&e.message),
            }
        });
    }

    fn sync_save(&self) {
        let saved = self
            .settings
            .borrow()
            .as_ref()
            .map(|s| s.instructions.clone())
            .unwrap_or_default();
        let text = self.instructions.text();
        let text = text.trim();
        self.save.set_sensitive(!text.is_empty() && text != saved);
    }

    fn render_settings(&self, text_too: bool) {
        let Some(s) = self.settings.borrow().clone() else {
            return;
        };
        self.syncing.set(true);
        self.on.set_active(s.enabled);
        let every: Vec<_> = looking::every_choices(s.every_minutes)
            .into_iter()
            .map(|m| (m.to_string(), looking::every(m)))
            .collect();
        self.every.set(&every, &s.every_minutes.to_string());
        let bots: Vec<_> = {
            let st = self.store.state();
            st.bot_ids
                .iter()
                .map(|b| (b.clone(), st.bot_name(Some(b))))
                .collect()
        };
        self.bot.set(&looking::choices(&bots, &s.bot_id), &s.bot_id);
        if text_too {
            self.instructions.set_text(&s.instructions);
        }
        self.syncing.set(false);
        self.sync_save();
    }

    fn save_with(self: &Rc<Self>, edit: impl FnOnce(&mut HeartbeatSettings)) {
        let Some(mut s) = self.settings.borrow().clone() else {
            return;
        };
        edit(&mut s);
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.save_settings(&json!({ "heartbeat": s })).await;
            let Some(h) = weak.upgrade() else { return };
            match result {
                Ok(all) => {
                    h.error.set_visible(false);
                    h.settings.replace(all.heartbeat);
                }
                Err(e) => h.show_error(&e.message),
            }
            h.render_settings(false);
        });
    }

    fn render_info(self: &Rc<Self>) {
        let info = self.info.borrow().clone().unwrap_or_default();
        let last = adw::PreferencesGroup::builder().title("Last look").build();
        match &info.at {
            Some(at) => {
                last.add(&property("Looked", &format::stamp(at)));
                for f in &info.found {
                    last.add(&adw::ActionRow::builder().title(f).use_markup(false).build());
                }
                if !info.note.is_empty() {
                    let l = note(&info.note);
                    last.add(&l);
                }
                if let Some(task) = info.task_id {
                    last.add(&nav_row("Its task", move || route::go(Link::Task(task))));
                }
            }
            None => last.add(&note("Not yet.")),
        }
        let look = adw::ButtonRow::builder()
            .title(if self.looking.get() {
                "Looking…"
            } else {
                "Look Now"
            })
            .sensitive(!self.looking.get())
            .build();
        let weak = Rc::downgrade(self);
        look.connect_activated(move |_| {
            if let Some(h) = weak.upgrade() {
                h.look();
            }
        });
        let looks = adw::PreferencesGroup::new();
        looks.add(&look);
        let mut groups = vec![last, looks];
        if !info.recent.is_empty() {
            let before = adw::PreferencesGroup::builder().title("Before").build();
            for run in &info.recent {
                let row = adw::ActionRow::builder()
                    .title(format::stamp(&run.at))
                    .build();
                row.add_suffix(
                    &gtk::Label::builder()
                        .label(looking::heartbeat_line(run))
                        .wrap(true)
                        .xalign(1.0)
                        .css_classes(["dim-label"])
                        .build(),
                );
                before.add(&row);
            }
            groups.push(before);
        }
        self.groups.replace(&self.prefs, groups);
    }

    fn look(self: &Rc<Self>) {
        if self.looking.replace(true) {
            return;
        }
        self.render_info();
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.run_heartbeat().await;
            let Some(h) = weak.upgrade() else { return };
            h.looking.set(false);
            match result {
                Ok(info) => {
                    h.error.set_visible(false);
                    h.info.replace(Some(info));
                }
                Err(e) => h.show_error(&e.message),
            }
            h.render_info();
        });
    }
}
