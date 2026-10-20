// Schedules & Triggers: the list of both, and a schedule's page, which also adds one (PLAN.md §24.2
// L5, SchedulesView.swift on iOS). Triggers are set up on the web; their page is trigger.rs.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use gtk::glib::DateTime;
use hatbot::core::format;
use hatbot::core::links::Link;
use hatbot::core::models::{Schedule, TriggerKind};
use hatbot::core::schedule::ScheduleForm;
use hatbot::store::{Change, Listener, Store};

use super::form::{TextArea, bot_row, confirm, error_label, note};
use super::icon::Icon;
use super::route;
use super::shell::Banners;

pub struct Schedules {
    pub page: adw::NavigationPage,
    _inner: Rc<Inner>,
    _listener: Listener,
}

struct Inner {
    store: Store,
    error: gtk::Label,
    schedules: adw::PreferencesGroup,
    triggers: adw::PreferencesGroup,
    rows: RefCell<Vec<(adw::PreferencesGroup, gtk::Widget)>>,
    loaded: Cell<bool>,
}

impl Schedules {
    pub fn new(store: &Store, banners: &Banners) -> Schedules {
        let add = gtk::Button::builder()
            .icon_name("list-add-symbolic")
            .tooltip_text("New Schedule")
            .build();
        let header = adw::HeaderBar::new();
        header.pack_end(&add);
        let error = error_label();
        let top = adw::PreferencesGroup::new();
        top.add(&error);
        let schedules = adw::PreferencesGroup::builder().title("Schedules").build();
        let triggers = adw::PreferencesGroup::builder().title("Triggers").build();
        let prefs = adw::PreferencesPage::new();
        prefs.add(&top);
        prefs.add(&schedules);
        prefs.add(&triggers);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        banners.add(&view);
        view.set_content(Some(&prefs));
        let page = adw::NavigationPage::builder()
            .title("Schedules & Triggers")
            .tag("schedules")
            .child(&view)
            .build();

        let inner = Rc::new(Inner {
            store: store.clone(),
            error,
            schedules,
            triggers,
            rows: RefCell::default(),
            loaded: Cell::new(false),
        });
        let s = store.clone();
        add.connect_clicked(move |_| {
            let p = SchedulePage::new(&s, None);
            route::push(p.page.clone(), Box::new(p));
        });
        let weak = Rc::downgrade(&inner);
        page.connect_showing(move |_| {
            let Some(i) = weak.upgrade() else { return };
            let weak = Rc::downgrade(&i);
            let store = i.store.clone();
            glib::spawn_future_local(async move {
                let result = store.load_schedules().await;
                let Some(i) = weak.upgrade() else { return };
                match result {
                    Ok(()) => {
                        i.loaded.set(true);
                        i.error.set_visible(false);
                    }
                    Err(e) => {
                        i.error.set_label(&e.message);
                        i.error.set_visible(true);
                    }
                }
                i.render();
            });
        });
        let weak = Rc::downgrade(&inner);
        let listener = store.listen(move |change| {
            if matches!(
                change,
                Change::Schedules | Change::Schedule(_) | Change::Trigger(_) | Change::Chats
            ) && let Some(i) = weak.upgrade()
            {
                i.render();
            }
        });
        inner.render();
        Schedules {
            page,
            _inner: inner,
            _listener: listener,
        }
    }
}

impl Inner {
    fn render(&self) {
        for (group, row) in self.rows.borrow_mut().drain(..) {
            group.remove(&row);
        }
        let st = self.store.state();
        let mut rows = self.rows.borrow_mut();
        let mut schedules: Vec<_> = st.schedules.values().collect();
        schedules.sort_by_key(|s| s.id);
        for s in &schedules {
            let subtitle = if s.enabled {
                format::when(s.cron.as_deref(), s.run_at.as_deref())
            } else {
                "Off".into()
            };
            let row = link_row(&s.name, &subtitle, !s.enabled, Link::Schedule(s.id));
            self.schedules.add(&row);
            rows.push((self.schedules.clone(), row.upcast()));
        }
        let mut triggers: Vec<_> = st.triggers.values().collect();
        triggers.sort_by_key(|t| t.id);
        for t in &triggers {
            let subtitle = match (t.enabled, t.kind) {
                (false, _) => "Off",
                (true, TriggerKind::Kuma) => "Uptime Kuma",
                (true, _) => "Webhook",
            };
            let row = link_row(&t.name, subtitle, !t.enabled, Link::Trigger(t.id));
            self.triggers.add(&row);
            rows.push((self.triggers.clone(), row.upcast()));
        }
        if self.loaded.get() {
            for (group, empty, text) in [
                (
                    &self.schedules,
                    schedules.is_empty(),
                    "No schedules. Ask Hatbot in the chat, or add one.",
                ),
                (
                    &self.triggers,
                    triggers.is_empty(),
                    "No triggers. Set up webhooks and Uptime Kuma on the web.",
                ),
            ] {
                if empty {
                    let l = note(text);
                    group.add(&l);
                    rows.push((group.clone(), l.upcast()));
                }
            }
        }
    }
}

fn link_row(title: &str, subtitle: &str, off: bool, link: Link) -> adw::ActionRow {
    let row = adw::ActionRow::builder()
        .title(title)
        .subtitle(subtitle)
        .use_markup(false)
        .activatable(true)
        .build();
    if off {
        row.add_css_class("dim-label");
    }
    row.add_suffix(&gtk::Image::from_icon_name("go-next-symbolic"));
    row.connect_activated(move |_| route::go(link.clone()));
    row
}

/// A schedule's page, or a new schedule's when `id` is None.
pub struct SchedulePage {
    pub page: adw::NavigationPage,
    _inner: Rc<Page>,
    _listener: Listener,
}

struct Page {
    store: Store,
    id: Cell<Option<i64>>,
    page: adw::NavigationPage,
    stack: gtk::Stack,
    save: gtk::Button,
    error: gtk::Label,
    tainted: gtk::Box,
    tainted_text: gtk::Label,
    name: adw::EntryRow,
    on: adw::SwitchRow,
    bots: Option<(adw::ComboRow, Vec<String>)>,
    when: adw::ToggleGroup,
    cron: adw::EntryRow,
    cron_words: gtk::Label,
    cron_note: gtk::Label,
    at_row: adw::ActionRow,
    at_button: gtk::MenuButton,
    calendar: gtk::Calendar,
    hour: gtk::SpinButton,
    minute: gtk::SpinButton,
    at: RefCell<DateTime>,
    prompt: TextArea,
    last_run: adw::ActionRow,
    next_run: adw::ActionRow,
    next_run_at: gtk::Label,
    started: adw::ActionRow,
    started_id: Cell<Option<i64>>,
    /// The form as saved; a new one counts as changed.
    saved: RefCell<Option<ScheduleForm>>,
    filling: Cell<bool>,
    busy: Cell<bool>,
}

impl SchedulePage {
    pub fn new(store: &Store, id: Option<i64>) -> SchedulePage {
        let save = gtk::Button::builder()
            .label(if id.is_some() { "Save" } else { "Add" })
            .css_classes(["suggested-action"])
            .build();
        let header = adw::HeaderBar::new();
        header.pack_end(&save);

        let error = error_label();
        let tainted_text = gtk::Label::builder()
            .xalign(0.0)
            .wrap(true)
            .hexpand(true)
            .css_classes(["caption"])
            .build();
        let shield = Icon::new("shield", 16);
        shield.set_valign(gtk::Align::Start);
        let tainted = gtk::Box::builder()
            .spacing(8)
            .visible(false)
            .css_classes(["warning"])
            .build();
        tainted.append(&shield);
        tainted.append(&tainted_text);
        let top = adw::PreferencesGroup::new();
        top.add(&error);
        top.add(&tainted);

        let name = adw::EntryRow::builder().title("Name").build();
        let on = adw::SwitchRow::builder().title("On").active(true).build();
        let bots = bot_row(store, "hatbot");
        let main = adw::PreferencesGroup::new();
        main.add(&name);
        main.add(&on);
        if let Some((row, _)) = &bots {
            main.add(row);
        }

        let when = adw::ToggleGroup::builder()
            .valign(gtk::Align::Center)
            .build();
        for (n, label) in [("repeats", "Repeats"), ("once", "Once")] {
            when.add(adw::Toggle::builder().name(n).label(label).build());
        }
        when.set_active_name(Some("repeats"));
        let cron = adw::EntryRow::builder().title("Cron").build();
        if let Some(text) = cron.delegate() {
            text.add_css_class("monospace");
        }
        let calendar = gtk::Calendar::new();
        let spin = |max: f64| {
            gtk::SpinButton::builder()
                .adjustment(&gtk::Adjustment::new(0.0, 0.0, max, 1.0, 5.0, 0.0))
                .orientation(gtk::Orientation::Vertical)
                .numeric(true)
                .wrap(true)
                .build()
        };
        let (hour, minute) = (spin(23.0), spin(59.0));
        let time = gtk::Box::builder()
            .spacing(6)
            .halign(gtk::Align::Center)
            .build();
        time.append(&hour);
        time.append(&gtk::Label::new(Some(":")));
        time.append(&minute);
        let picker = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(12)
            .build();
        picker.append(&calendar);
        picker.append(&time);
        let at_button = gtk::MenuButton::builder()
            .valign(gtk::Align::Center)
            .popover(&gtk::Popover::builder().child(&picker).build())
            .build();
        let at_row = adw::ActionRow::builder().title("At").build();
        at_row.add_suffix(&at_button);
        let cron_words = note("");
        let cron_note =
            note("Minute, hour, day of month, month, day of week, in the brain's time zone.");
        let timing = adw::PreferencesGroup::builder()
            .title("When")
            .header_suffix(&when)
            .build();
        timing.add(&cron);
        timing.add(&at_row);
        timing.add(&cron_words);
        timing.add(&cron_note);

        let prompt = TextArea::new("Everything the run needs to know: it can't see the chat.");
        let what = adw::PreferencesGroup::builder()
            .title("What it does")
            .build();
        what.add(&prompt.root);

        let last_run = adw::ActionRow::builder()
            .title("Last run")
            .activatable(true)
            .build();
        last_run.add_suffix(&gtk::Image::from_icon_name("go-next-symbolic"));
        let next_run_at = gtk::Label::builder().css_classes(["dim-label"]).build();
        let next_run = adw::ActionRow::builder().title("Next run").build();
        next_run.add_suffix(&next_run_at);
        let run_now = adw::ButtonRow::builder().title("Run Now").build();
        let started = adw::ActionRow::builder()
            .activatable(true)
            .visible(false)
            .build();
        started.add_suffix(&gtk::Image::from_icon_name("go-next-symbolic"));
        let runs = adw::PreferencesGroup::builder()
            .visible(id.is_some())
            .build();
        runs.add(&last_run);
        runs.add(&next_run);
        runs.add(&run_now);
        runs.add(&started);
        let delete_row = adw::ButtonRow::builder().title("Delete Schedule").build();
        // Not the builder's css_classes: they would drop the row's own "button".
        delete_row.add_css_class("destructive-action");
        let delete = adw::PreferencesGroup::builder()
            .visible(id.is_some())
            .build();
        delete.add(&delete_row);

        let prefs = adw::PreferencesPage::new();
        for g in [&top, &main, &timing, &what, &runs, &delete] {
            prefs.add(g);
        }
        let gone = adw::StatusPage::builder()
            .icon_name("dialog-question-symbolic")
            .title("This schedule doesn't exist.")
            .build();
        let stack = gtk::Stack::new();
        stack.add_named(&adw::Spinner::new(), Some("loading"));
        stack.add_named(&gone, Some("gone"));
        stack.add_named(&prefs, Some("form"));
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        view.set_content(Some(&stack));
        let page = adw::NavigationPage::builder()
            .title(if id.is_some() {
                "Schedule"
            } else {
                "New Schedule"
            })
            .child(&view)
            .build();

        let p = Rc::new(Page {
            store: store.clone(),
            id: Cell::new(id),
            page: page.clone(),
            stack,
            save,
            error,
            tainted,
            tainted_text,
            name,
            on,
            bots,
            when,
            cron,
            cron_words,
            cron_note,
            at_row,
            at_button,
            calendar,
            hour,
            minute,
            at: RefCell::new(ScheduleForm::default().at),
            prompt,
            last_run,
            next_run,
            next_run_at,
            started,
            started_id: Cell::new(None),
            saved: RefCell::default(),
            filling: Cell::new(false),
            busy: Cell::new(false),
        });
        p.connect(&run_now, &delete_row);
        if id.is_none() {
            p.fill(&ScheduleForm::default());
            p.stack.set_visible_child_name("form");
        }
        p.render();
        let weak = Rc::downgrade(&p);
        let listener = store.listen(move |change| {
            let Some(p) = weak.upgrade() else { return };
            if let (Change::Schedule(id), Some(mine)) = (change, p.id.get())
                && *id == mine
            {
                p.render();
            }
        });
        if let Some(id) = id {
            let weak = Rc::downgrade(&p);
            let store = store.clone();
            glib::spawn_future_local(async move {
                let result = store.load_schedule(id).await;
                let Some(p) = weak.upgrade() else { return };
                if let Err(e) = result
                    && e.status != 404
                {
                    p.show_error(&e.message);
                    p.stack.set_visible_child_name("form");
                }
                p.render();
            });
        }
        SchedulePage {
            page,
            _inner: p,
            _listener: listener,
        }
    }
}

impl Page {
    fn connect(self: &Rc<Self>, run_now: &adw::ButtonRow, delete: &adw::ButtonRow) {
        let changed = {
            let weak = Rc::downgrade(self);
            move || {
                if let Some(p) = weak.upgrade()
                    && !p.filling.get()
                {
                    p.sync();
                }
            }
        };
        let c = changed.clone();
        self.name.connect_changed(move |_| c());
        let c = changed.clone();
        self.on.connect_active_notify(move |_| c());
        if let Some((row, _)) = &self.bots {
            let c = changed.clone();
            row.connect_selected_notify(move |_| c());
        }
        let c = changed.clone();
        self.when.connect_active_name_notify(move |_| c());
        let c = changed.clone();
        self.cron.connect_changed(move |_| c());
        let c = changed.clone();
        self.prompt.view.buffer().connect_changed(move |_| c());
        let weak = Rc::downgrade(self);
        let set_at = move || {
            let Some(p) = weak.upgrade() else { return };
            if p.filling.get() {
                return;
            }
            let day = p.calendar.date();
            if let Ok(at) = DateTime::from_local(
                day.year(),
                day.month(),
                day.day_of_month(),
                p.hour.value_as_int(),
                p.minute.value_as_int(),
                0.0,
            ) {
                p.at.replace(at);
            }
            p.sync();
        };
        let s = set_at.clone();
        self.calendar.connect_day_selected(move |_| s());
        let s = set_at.clone();
        self.hour.connect_value_changed(move |_| s());
        self.minute.connect_value_changed(move |_| set_at());

        let weak = Rc::downgrade(self);
        self.save.connect_clicked(move |_| {
            if let Some(p) = weak.upgrade() {
                p.save();
            }
        });
        let weak = Rc::downgrade(self);
        self.last_run.connect_activated(move |_| {
            let Some(p) = weak.upgrade() else { return };
            let last = p.id.get().and_then(|id| {
                p.store
                    .state()
                    .schedules
                    .get(&id)
                    .and_then(|s| s.last_task_id)
            });
            if let Some(task) = last {
                route::go(Link::Task(task));
            }
        });
        let weak = Rc::downgrade(self);
        self.started.connect_activated(move |_| {
            if let Some(task) = weak.upgrade().and_then(|p| p.started_id.get()) {
                route::go(Link::Task(task));
            }
        });
        let weak = Rc::downgrade(self);
        run_now.connect_activated(move |_| {
            if let Some(p) = weak.upgrade() {
                p.run_now();
            }
        });
        let weak = Rc::downgrade(self);
        delete.connect_activated(move |row| {
            let Some(p) = weak.upgrade() else { return };
            let name = p.saved.borrow().as_ref().map(|f| f.name.clone());
            let weak = Rc::downgrade(&p);
            confirm(
                row,
                &format!("Delete “{}”?", name.unwrap_or_default()),
                "Delete",
                move || {
                    if let Some(p) = weak.upgrade() {
                        p.delete();
                    }
                },
            );
        });
    }

    fn show_error(&self, text: &str) {
        self.error.set_label(text);
        self.error.set_visible(true);
    }

    /// The form's fields from `f`, without counting as your changes.
    fn fill(&self, f: &ScheduleForm) {
        self.filling.set(true);
        self.name.set_text(&f.name);
        self.on.set_active(f.enabled);
        if let Some((row, ids)) = &self.bots {
            row.set_selected(ids.iter().position(|b| *b == f.bot_id).unwrap_or(0) as u32);
        }
        self.when
            .set_active_name(Some(if f.repeats { "repeats" } else { "once" }));
        self.cron.set_text(&f.cron);
        self.at.replace(f.at.clone());
        self.calendar.select_day(&f.at);
        self.hour.set_value(f.at.hour() as f64);
        self.minute.set_value(f.at.minute() as f64);
        self.prompt.set_text(&f.prompt);
        self.filling.set(false);
        self.sync();
    }

    fn form(&self) -> ScheduleForm {
        ScheduleForm {
            name: self.name.text().into(),
            repeats: self.when.active_name().as_deref() != Some("once"),
            cron: self.cron.text().into(),
            at: self.at.borrow().clone(),
            prompt: self.prompt.text(),
            enabled: self.on.is_active(),
            bot_id: self
                .bots
                .as_ref()
                .and_then(|(row, ids)| ids.get(row.selected() as usize).cloned())
                .or_else(|| self.saved.borrow().as_ref().map(|f| f.bot_id.clone()))
                .unwrap_or_else(|| "hatbot".into()),
        }
    }

    /// What follows from the fields: cron in words, which of cron and time shows, and Save.
    fn sync(&self) {
        let f = self.form();
        self.cron.set_visible(f.repeats);
        self.cron_words.set_visible(f.repeats);
        self.cron_note.set_visible(f.repeats);
        self.at_row.set_visible(!f.repeats);
        self.cron_words
            .set_label(&format::describe_cron(f.cron.trim()));
        self.at_button.set_label(
            &f.at
                .format("%a %-d %b, %H:%M")
                .map(|s| s.to_string())
                .unwrap_or_default(),
        );
        let changed = self.saved.borrow().as_ref() != Some(&f) || self.id.get().is_none();
        self.save
            .set_sensitive(!self.busy.get() && f.valid() && changed);
    }

    /// The stored schedule: the form once it first comes, and its runs whenever they change.
    fn render(&self) {
        let Some(id) = self.id.get() else { return };
        let st = self.store.state();
        let Some(s) = st.schedules.get(&id).cloned() else {
            if st.deleted_schedules.contains(&id) {
                self.stack.set_visible_child_name("gone");
            }
            return;
        };
        drop(st);
        self.stack.set_visible_child_name("form");
        self.page.set_title(&s.name);
        if self.saved.borrow().is_none() {
            let f = ScheduleForm::from(&s);
            self.saved.replace(Some(f.clone()));
            self.fill(&f);
        }
        self.render_runs(&s);
    }

    fn render_runs(&self, s: &Schedule) {
        self.tainted.set_visible(s.tainted);
        let by = s
            .tainted_by
            .as_deref()
            .map(|b| format!(" ({b})"))
            .unwrap_or_default();
        self.tainted_text.set_label(&format!(
            "Made or changed by the chat after it read untrusted content{by}, so its runs ask before changing anything. Saving it yourself clears this."
        ));
        self.last_run.set_visible(s.last_task_id.is_some());
        let next = s.next_run_at.as_deref().filter(|_| s.enabled);
        self.next_run.set_visible(next.is_some());
        self.next_run_at
            .set_label(&next.map(format::stamp).unwrap_or_default());
    }

    fn save(self: &Rc<Self>) {
        if self.busy.replace(true) {
            return;
        }
        self.sync();
        let form = self.form();
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id.get());
        glib::spawn_future_local(async move {
            let result = store.save_schedule(id, &form.change()).await;
            let Some(p) = weak.upgrade() else { return };
            p.busy.set(false);
            match result {
                Ok(s) if id.is_none() => {
                    store.toast(&format!("Scheduled {}", s.name));
                    let _ = p.page.activate_action("navigation.pop", None);
                }
                Ok(s) => {
                    p.error.set_visible(false);
                    let f = ScheduleForm::from(&s);
                    p.saved.replace(Some(f.clone()));
                    p.fill(&f);
                    p.render_runs(&s);
                    store.toast("Saved");
                }
                Err(e) => {
                    p.show_error(&e.message);
                    p.sync();
                }
            }
        });
    }

    fn run_now(self: &Rc<Self>) {
        let Some(id) = self.id.get() else { return };
        if self.busy.replace(true) {
            return;
        }
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.run_schedule(id).await;
            let Some(p) = weak.upgrade() else { return };
            p.busy.set(false);
            match result {
                Ok(task) => {
                    p.error.set_visible(false);
                    p.started_id.set(Some(task.id));
                    p.started.set_title(&format!("Started task #{}", task.id));
                    p.started.set_visible(true);
                }
                Err(e) => p.show_error(&e.message),
            }
            p.sync();
        });
    }

    fn delete(self: &Rc<Self>) {
        let Some(id) = self.id.get() else { return };
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.delete_schedule(id).await;
            let Some(p) = weak.upgrade() else { return };
            match result {
                Ok(()) => {
                    let _ = p.page.activate_action("navigation.pop", None);
                }
                Err(e) => p.show_error(&e.message),
            }
        });
    }
}
