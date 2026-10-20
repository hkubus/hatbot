// Settings (PLAN.md §23.2 L6, SettingsView and SpendView on iOS): spend, limits, looking after
// things, models and effort, what notifications open, safety and signed-in devices. Each switch and
// picker saves on its own; limits save together.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use hatbot::core::chart::ChartSpec;
use hatbot::core::format;
use hatbot::core::looking::{self, dollars_text};
use hatbot::core::models::{AppSettings, Device, Limits, SpendSummary};
use hatbot::core::spend::{self, SpendDetail};
use hatbot::store::{Change, Listener, Store};
use serde_json::{Value, json};

use super::chart;
use super::form::{Choice, error_label, nav_row, note};
use super::looking::{ChecksPage, HeartbeatPage, WatchersPage};
use super::route;
use super::shell::Banners;

const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// Whether a group's settings came from the brain.
type Shown = fn(&AppSettings) -> bool;

pub struct Settings {
    pub page: adw::NavigationPage,
    _inner: Rc<Root>,
    _listener: Listener,
}

struct Root {
    store: Store,
    error: gtk::Label,
    today: gtk::Label,
    month: gtk::Label,
    tokens: (adw::ActionRow, gtk::Label),
    last_hour: (adw::ActionRow, gtk::Label),
    last_minute: (adw::ActionRow, gtk::Label),
    weekly: adw::SwitchRow,
    weekday: Rc<Choice>,
    hour: Rc<Choice>,
    send_report: adw::ButtonRow,
    tidy: adw::SwitchRow,
    todo_hour: Rc<Choice>,
    chat_model: Rc<Choice>,
    chat_effort: Rc<Choice>,
    task_model: Rc<Choice>,
    desktop_model: Rc<Choice>,
    escalate: adw::SwitchRow,
    opens: Rc<Choice>,
    review: adw::SwitchRow,
    groups: Vec<(adw::PreferencesGroup, Shown)>,
    settings: RefCell<Option<AppSettings>>,
    summary: RefCell<Option<SpendSummary>>,
    /// Saves on their way: a load meanwhile would put back what they change.
    saving: Cell<u32>,
    syncing: Cell<bool>,
}

fn value_row(title: &str) -> (adw::ActionRow, gtk::Label) {
    let label = gtk::Label::builder().css_classes(["dim-label"]).build();
    let row = adw::ActionRow::builder().title(title).build();
    row.add_suffix(&label);
    (row, label)
}

fn hours() -> Vec<(String, String)> {
    (0..24)
        .map(|h| (h.to_string(), format!("{h:02}:00")))
        .collect()
}

impl Settings {
    pub fn new(store: &Store, banners: &Banners) -> Settings {
        let error = error_label();
        let top = adw::PreferencesGroup::new();
        top.add(&error);

        let spend = adw::PreferencesGroup::builder().title("Spend").build();
        let (today_row, today) = value_row("Today");
        let (month_row, month) = value_row("This month");
        let tokens = value_row("Tokens today");
        let last_hour = value_row("Last hour");
        let last_minute = value_row("Last minute");
        for r in [
            &today_row,
            &month_row,
            &tokens.0,
            &last_hour.0,
            &last_minute.0,
        ] {
            spend.add(r);
        }
        let s = store.clone();
        spend.add(&nav_row("Spend by hour, day, model and bot", move || {
            let p = SpendPage::new(&s);
            route::push(p.page.clone(), Box::new(p));
        }));
        let s = store.clone();
        spend.add(&nav_row("Limits", move || {
            let p = LimitsPage::new(&s);
            route::push(p.page.clone(), Box::new(p));
        }));

        let watching = adw::PreferencesGroup::new();
        let s = store.clone();
        watching.add(&nav_row("Watchers", move || {
            let p = WatchersPage::new(&s);
            route::push(p.page.clone(), Box::new(p));
        }));

        let looking = adw::PreferencesGroup::builder()
            .title("Looking after things")
            .build();
        let s = store.clone();
        looking.add(&nav_row("Check everything", move || {
            let p = ChecksPage::new(&s);
            route::push(p.page.clone(), Box::new(p));
        }));
        let s = store.clone();
        looking.add(&nav_row("Heartbeat", move || {
            let p = HeartbeatPage::new(&s);
            route::push(p.page.clone(), Box::new(p));
        }));

        let chat = adw::PreferencesGroup::builder().title("Chat").build();
        let tasks = adw::PreferencesGroup::builder().title("Tasks").build();
        let desktop = adw::PreferencesGroup::builder().title("Desktop").build();
        let notifications = adw::PreferencesGroup::builder()
            .title("Notifications")
            .description("Notifications come from the ntfy app.")
            .build();
        let safety = adw::PreferencesGroup::builder().title("Safety").build();
        let device = adw::PreferencesGroup::new();
        let (server, host) = value_row("Server");
        host.set_label(
            &glib::Uri::parse(store.api().server(), glib::UriFlags::NONE)
                .ok()
                .and_then(|u| u.host())
                .map(|h| h.to_string())
                .unwrap_or_default(),
        );
        device.add(&server);
        let s = store.clone();
        device.add(&nav_row("Signed-in devices", move || {
            let p = DevicesPage::new(&s);
            route::push(p.page.clone(), Box::new(p));
        }));

        let prefs = adw::PreferencesPage::new();
        for g in [
            &top,
            &spend,
            &watching,
            &looking,
            &chat,
            &tasks,
            &desktop,
            &notifications,
            &safety,
            &device,
        ] {
            prefs.add(g);
        }
        let view = adw::ToolbarView::new();
        view.add_top_bar(&adw::HeaderBar::new());
        banners.add(&view);
        view.set_content(Some(&prefs));
        let page = adw::NavigationPage::builder()
            .title("Settings")
            .tag("settings")
            .child(&view)
            .build();

        let root = Rc::new_cyclic(|weak: &std::rc::Weak<Root>| {
            // Each picker saves its own key.
            let pick = |key: &'static str, number: bool| {
                let weak = weak.clone();
                move |v: &str| {
                    if let Some(r) = weak.upgrade() {
                        let value = if number {
                            json!(v.parse::<i64>().unwrap_or(0))
                        } else {
                            json!(v)
                        };
                        r.save(json!({ key: value }));
                    }
                }
            };
            let w = weak.clone();
            let weekly_pick = move |field: &'static str| {
                let w = w.clone();
                move |v: &str| {
                    if let Some(r) = w.upgrade() {
                        r.save_weekly(|wr| match field {
                            "weekday" => wr.weekday = v.parse().unwrap_or(1),
                            _ => wr.hour = v.parse().unwrap_or(9),
                        });
                    }
                }
            };
            Root {
                store: store.clone(),
                error,
                today,
                month,
                tokens,
                last_hour,
                last_minute,
                weekly: adw::SwitchRow::builder().title("Weekly report").build(),
                weekday: Choice::new("Day", weekly_pick("weekday")),
                hour: Choice::new("Time", weekly_pick("hour")),
                send_report: adw::ButtonRow::builder()
                    .title("Send the Report Now")
                    .build(),
                tidy: adw::SwitchRow::builder()
                    .title("Propose a memory tidy-up weekly")
                    .build(),
                todo_hour: Choice::new("To-do reminder each morning at", pick("todoHour", true)),
                chat_model: Choice::new("Model", pick("chatModel", false)),
                chat_effort: Choice::new("Effort", pick("chatEffort", false)),
                task_model: Choice::new("Model for background tasks", pick("taskModel", false)),
                desktop_model: Choice::new("Model for desktop tasks", pick("desktopModel", false)),
                escalate: adw::SwitchRow::builder()
                    .title("Try again on Opus when Haiku fails")
                    .build(),
                opens: Choice::new("Tapping one opens", pick("notificationsOpen", false)),
                review: adw::SwitchRow::builder()
                    .title("Let Haiku allow safe changes")
                    .build(),
                groups: vec![
                    (chat.clone(), |s| s.chat_model.is_some()),
                    (tasks.clone(), |s| s.task_model.is_some()),
                    (desktop.clone(), |s| s.desktop_model.is_some()),
                    (notifications.clone(), |s| s.notifications_open.is_some()),
                    (safety.clone(), |s| s.review_changes.is_some()),
                ],
                settings: RefCell::default(),
                summary: RefCell::default(),
                saving: Cell::new(0),
                syncing: Cell::new(false),
            }
        });
        for w in [
            root.weekly.upcast_ref::<gtk::Widget>(),
            root.weekday.row.upcast_ref(),
            root.hour.row.upcast_ref(),
            root.send_report.upcast_ref(),
            root.tidy.upcast_ref(),
            root.todo_hour.row.upcast_ref(),
        ] {
            looking.add(w);
        }
        // Haiku's name is long.
        root.chat_model.row.set_use_subtitle(true);
        chat.add(&root.chat_model.row);
        chat.add(&root.chat_effort.row);
        tasks.add(&root.task_model.row);
        desktop.add(&root.desktop_model.row);
        desktop.add(&root.escalate);
        notifications.add(&root.opens.row);
        safety.add(&root.review);
        root.connect();

        let weak = Rc::downgrade(&root);
        page.connect_showing(move |_| {
            if let Some(r) = weak.upgrade() {
                r.load();
            }
        });
        let weak = Rc::downgrade(&root);
        let listener = store.listen(move |change| {
            let Some(r) = weak.upgrade() else { return };
            match change {
                Change::Settings => r.load(),
                Change::Spend => r.render_spend(),
                _ => {}
            }
        });
        Settings {
            page,
            _inner: root,
            _listener: listener,
        }
    }
}

impl Root {
    fn connect(self: &Rc<Self>) {
        let switch = |row: &adw::SwitchRow, key: &'static str| {
            let weak = Rc::downgrade(self);
            row.connect_active_notify(move |row| {
                if let Some(r) = weak.upgrade()
                    && !r.syncing.get()
                {
                    r.save(json!({ key: row.is_active() }));
                }
            });
        };
        switch(&self.tidy, "memoryTidy");
        switch(&self.escalate, "desktopEscalate");
        switch(&self.review, "reviewChanges");
        let weak = Rc::downgrade(self);
        self.weekly.connect_active_notify(move |row| {
            if let Some(r) = weak.upgrade()
                && !r.syncing.get()
            {
                let on = row.is_active();
                r.save_weekly(|w| w.enabled = on);
            }
        });
        let weak = Rc::downgrade(self);
        self.send_report.connect_activated(move |row| {
            let Some(r) = weak.upgrade() else { return };
            row.set_sensitive(false);
            let (weak, store, row) = (Rc::downgrade(&r), r.store.clone(), row.clone());
            glib::spawn_future_local(async move {
                let result = store.send_report().await;
                row.set_sensitive(true);
                match result {
                    Ok(()) => store.toast("Sent to the chat"),
                    Err(e) => {
                        if let Some(r) = weak.upgrade() {
                            r.show_error(&e.message);
                        }
                    }
                }
            });
        });
    }

    fn show_error(&self, text: &str) {
        self.error.set_label(text);
        self.error.set_visible(true);
    }

    fn load(self: &Rc<Self>) {
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let (settings, summary) =
                futures_util::join!(store.load_settings(), store.spend_summary());
            let Some(r) = weak.upgrade() else { return };
            match settings {
                Ok(s) if r.saving.get() == 0 => {
                    r.error.set_visible(false);
                    r.settings.replace(Some(s));
                    r.render();
                }
                Ok(_) => {}
                Err(e) => r.show_error(&e.message),
            }
            if let Ok(s) = summary {
                r.summary.replace(Some(s));
                r.render_spend();
            }
        });
    }

    fn save(self: &Rc<Self>, change: Value) {
        self.saving.set(self.saving.get() + 1);
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.save_settings(&change).await;
            let Some(r) = weak.upgrade() else { return };
            r.saving.set(r.saving.get() - 1);
            match result {
                Ok(s) => {
                    r.error.set_visible(false);
                    r.settings.replace(Some(s));
                }
                Err(e) => r.show_error(&e.message),
            }
            // A failed save puts the control back.
            r.render();
        });
    }

    fn save_weekly(self: &Rc<Self>, edit: impl FnOnce(&mut hatbot::core::models::WeeklyReport)) {
        let Some(mut w) = self
            .settings
            .borrow()
            .as_ref()
            .and_then(|s| s.weekly_report.clone())
        else {
            return;
        };
        edit(&mut w);
        self.save(json!({ "weeklyReport": w }));
    }

    fn render_spend(&self) {
        let summary = self.summary.borrow();
        let limits = summary.as_ref().and_then(|s| s.limits.as_ref());
        let st = self.store.state();
        let of = |usd: Option<f64>, limit: Option<f64>| match (usd, limit) {
            (None, _) => "–".to_string(),
            (Some(u), Some(l)) => format!("{} of {}", format::money(u), format::money(l)),
            (Some(u), None) => format::money(u),
        };
        self.today
            .set_label(&of(st.today_usd, limits.map(|l| l.daily_usd)));
        self.month
            .set_label(&of(st.month_usd, limits.map(|l| l.monthly_usd)));
        let s = summary.as_ref();
        let tokens = s.and_then(|s| s.today_tokens);
        self.tokens.0.set_visible(tokens.is_some());
        self.tokens
            .1
            .set_label(&format::tokens(tokens.unwrap_or(0)));
        let hour = s.and_then(|s| s.last_hour.as_ref());
        self.last_hour.0.set_visible(hour.is_some());
        if let Some(h) = hour {
            self.last_hour.1.set_label(&format!(
                "{} · {} tokens",
                format::money(h.usd),
                format::tokens(h.tokens)
            ));
        }
        let minute = s.and_then(|s| s.last_minute.as_ref());
        self.last_minute.0.set_visible(minute.is_some());
        if let Some(m) = minute {
            self.last_minute.1.set_label(&format!(
                "${:.3} · {} tokens",
                m.usd,
                format::tokens(m.tokens)
            ));
        }
    }

    fn render(&self) {
        let Some(s) = self.settings.borrow().clone() else {
            return;
        };
        self.syncing.set(true);
        for (group, shown) in &self.groups {
            group.set_visible(shown(&s));
        }
        let weekly = s.weekly_report.as_ref();
        self.weekly.set_visible(weekly.is_some());
        self.send_report.set_visible(weekly.is_some());
        let on = weekly.is_some_and(|w| w.enabled);
        self.weekly.set_active(on);
        self.weekday.row.set_visible(on);
        self.hour.row.set_visible(on);
        if let Some(w) = weekly {
            let days: Vec<_> = WEEKDAYS
                .iter()
                .enumerate()
                .map(|(i, d)| (i.to_string(), d.to_string()))
                .collect();
            self.weekday.set(&days, &w.weekday.to_string());
            self.hour.set(&hours(), &w.hour.to_string());
        }
        self.tidy.set_visible(s.memory_tidy.is_some());
        self.tidy.set_active(s.memory_tidy == Some(true));
        self.todo_hour.row.set_visible(s.todo_hour.is_some());
        if let Some(h) = s.todo_hour {
            self.todo_hour.set(&hours(), &h.to_string());
        }
        if let Some(m) = &s.chat_model {
            let mut choices = looking::model_choices(m);
            if let Some(haiku) = choices.iter_mut().find(|(v, _)| v == looking::MODELS[0]) {
                haiku.1 = format!("{}, asks Opus for hard parts", haiku.1);
            }
            self.chat_model.set(&choices, m);
        }
        self.chat_effort.row.set_visible(s.chat_effort.is_some());
        if let Some(e) = &s.chat_effort {
            self.chat_effort.set(&looking::effort_choices(e), e);
        }
        if let Some(m) = &s.task_model {
            self.task_model.set(&looking::model_choices(m), m);
        }
        if let Some(m) = &s.desktop_model {
            self.desktop_model.set(&looking::model_choices(m), m);
        }
        self.escalate.set_visible(
            s.desktop_escalate.is_some() && s.desktop_model.as_deref() == Some(looking::MODELS[0]),
        );
        self.escalate.set_active(s.desktop_escalate == Some(true));
        if let Some(o) = &s.notifications_open {
            let choices = [
                ("web".to_string(), "The web app".to_string()),
                ("app".to_string(), "This app".to_string()),
            ];
            self.opens.set(&looking::choices(&choices, o), o);
        }
        self.review.set_active(s.review_changes == Some(true));
        self.syncing.set(false);
    }
}

/// The spending limits, saved together.
pub struct LimitsPage {
    pub page: adw::NavigationPage,
    _inner: Rc<LimitsForm>,
    _listener: Listener,
}

struct LimitsForm {
    store: Store,
    page: adw::NavigationPage,
    error: gtk::Label,
    save: gtk::Button,
    rows: Vec<(adw::EntryRow, &'static str)>,
    limits: RefCell<Option<Limits>>,
    saving: Cell<bool>,
}

const LIMITS: [(&str, &str); 6] = [
    ("taskUsd", "Each task"),
    ("researchUsd", "Each research task"),
    ("dailyUsd", "Each day"),
    ("monthlyUsd", "Each month"),
    ("alertReserveUsd", "Kept for alerts"),
    ("boxesUsd", "Boxes per day"),
];

fn limit_of(l: &Limits, key: &str) -> Option<f64> {
    match key {
        "taskUsd" => Some(l.task_usd),
        "researchUsd" => Some(l.research_usd),
        "dailyUsd" => Some(l.daily_usd),
        "monthlyUsd" => Some(l.monthly_usd),
        "alertReserveUsd" => l.alert_reserve_usd,
        _ => l.boxes_usd,
    }
}

impl LimitsPage {
    pub fn new(store: &Store) -> LimitsPage {
        let save = gtk::Button::builder()
            .label("Save")
            .sensitive(false)
            .css_classes(["suggested-action"])
            .build();
        let header = adw::HeaderBar::new();
        header.pack_end(&save);
        let error = error_label();
        let group = adw::PreferencesGroup::builder()
            .description("In dollars. Hatbot stops before going past one.")
            .build();
        let rows: Vec<_> = LIMITS
            .iter()
            .map(|(key, title)| {
                let row = adw::EntryRow::builder()
                    .title(*title)
                    .input_purpose(gtk::InputPurpose::Number)
                    .visible(false)
                    .build();
                row.add_prefix(&gtk::Label::new(Some("$")));
                group.add(&row);
                (row, *key)
            })
            .collect();
        let top = adw::PreferencesGroup::new();
        top.add(&error);
        let prefs = adw::PreferencesPage::new();
        prefs.add(&top);
        prefs.add(&group);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        view.set_content(Some(&prefs));
        let page = adw::NavigationPage::builder()
            .title("Limits")
            .child(&view)
            .build();
        let f = Rc::new(LimitsForm {
            store: store.clone(),
            page: page.clone(),
            error,
            save,
            rows,
            limits: RefCell::default(),
            saving: Cell::new(false),
        });
        for (row, _) in &f.rows {
            let weak = Rc::downgrade(&f);
            row.connect_changed(move |_| {
                if let Some(f) = weak.upgrade() {
                    f.sync();
                }
            });
        }
        let weak = Rc::downgrade(&f);
        f.save.connect_clicked(move |_| {
            if let Some(f) = weak.upgrade() {
                f.submit();
            }
        });
        f.load();
        let weak = Rc::downgrade(&f);
        let listener = store.listen(move |change| {
            if let (Some(f), Change::Settings) = (weak.upgrade(), change)
                && f.edited().is_none_or(|e| e.is_empty())
            {
                f.load();
            }
        });
        LimitsPage {
            page,
            _inner: f,
            _listener: listener,
        }
    }
}

impl LimitsForm {
    fn load(self: &Rc<Self>) {
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.load_settings().await;
            let Some(f) = weak.upgrade() else { return };
            match result.map(|s| s.limits) {
                Ok(Some(l)) => {
                    for (row, key) in &f.rows {
                        let value = limit_of(&l, key);
                        row.set_visible(value.is_some());
                        row.set_text(&value.map(dollars_text).unwrap_or_default());
                    }
                    f.limits.replace(Some(l));
                    f.sync();
                }
                Ok(None) => {}
                Err(e) => {
                    f.error.set_label(&e.message);
                    f.error.set_visible(true);
                }
            }
        });
    }

    /// The limits as typed, and which differ; None while one can't be read or is out of bounds.
    fn edited(&self) -> Option<Vec<(&'static str, f64)>> {
        let limits = self.limits.borrow();
        let l = limits.as_ref()?;
        let mut changed = vec![];
        for (row, key) in &self.rows {
            let Some(old) = limit_of(l, key) else {
                continue;
            };
            let value = looking::limit(&row.text(), old)?;
            let reserve = matches!(*key, "alertReserveUsd" | "boxesUsd");
            if (reserve && value < 0.0) || (!reserve && value <= 0.0) {
                return None;
            }
            if value != old {
                changed.push((*key, value));
            }
        }
        Some(changed)
    }

    fn sync(&self) {
        let edited = self.edited();
        self.save
            .set_sensitive(!self.saving.get() && edited.is_some_and(|e| !e.is_empty()));
    }

    fn submit(self: &Rc<Self>) {
        let Some(l) = self.limits.borrow().clone() else {
            return;
        };
        let mut all = serde_json::to_value(&l).unwrap_or_default();
        for (key, value) in self.edited().unwrap_or_default() {
            all[key] = json!(value);
        }
        self.saving.set(true);
        self.sync();
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.save_settings(&json!({ "limits": all })).await;
            let Some(f) = weak.upgrade() else { return };
            f.saving.set(false);
            match result {
                Ok(_) => {
                    store.toast("Saved");
                    let _ = f.page.activate_action("navigation.pop", None);
                }
                Err(e) => {
                    f.error.set_label(&e.message);
                    f.error.set_visible(true);
                    f.sync();
                }
            }
        });
    }
}

/// Spend in detail: by hour and day, and what it went on.
pub struct SpendPage {
    pub page: adw::NavigationPage,
}

impl SpendPage {
    pub fn new(store: &Store) -> SpendPage {
        let prefs = adw::PreferencesPage::new();
        let error = error_label();
        let top = adw::PreferencesGroup::new();
        top.add(&error);
        prefs.add(&top);
        let spinner = adw::Spinner::builder()
            .width_request(32)
            .height_request(32)
            .halign(gtk::Align::Center)
            .margin_top(24)
            .build();
        top.add(&spinner);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&adw::HeaderBar::new());
        view.set_content(Some(&prefs));
        let page = adw::NavigationPage::builder()
            .title("Spend")
            .child(&view)
            .build();
        let (weak, store) = (prefs.downgrade(), store.clone());
        glib::spawn_future_local(async move {
            let result = store.spend_detail().await;
            let Some(prefs) = weak.upgrade() else { return };
            spinner.set_visible(false);
            match result {
                Ok(d) => show_spend(&prefs, &store, &d),
                Err(e) => {
                    error.set_label(&e.message);
                    error.set_visible(true);
                }
            }
        });
        SpendPage { page }
    }
}

fn show_spend(prefs: &adw::PreferencesPage, store: &Store, d: &SpendDetail) {
    let mut charts = vec![
        ("Last 24 hours", spend::hourly(&d.hourly)),
        ("Last 30 days", spend::daily(&d.daily)),
        ("By model, last 30 days", spend::by_model(&d.by_model)),
    ];
    if store.state().bot_ids.len() > 1 {
        let st = store.state();
        let by_bot = spend::by_bot(&d.by_bot, |id| st.bots.get(id).map(|b| b.name.clone()));
        charts.push(("By bot, last 30 days", by_bot));
    }
    charts.push(("By purpose, last 30 days", spend::by_purpose(&d.by_purpose)));
    for (title, spec) in charts {
        let Some(spec): Option<ChartSpec> = spec else {
            continue;
        };
        let group = adw::PreferencesGroup::builder().title(title).build();
        let view = chart::view(&spec);
        view.set_margin_top(12);
        view.set_margin_bottom(12);
        view.set_margin_start(12);
        view.set_margin_end(12);
        // A row, so it's inside the group's card.
        group.add(
            &gtk::ListBoxRow::builder()
                .activatable(false)
                .selectable(false)
                .child(&view)
                .build(),
        );
        prefs.add(&group);
    }
}

/// What's signed in with a token, to revoke.
pub struct DevicesPage {
    pub page: adw::NavigationPage,
    _inner: Rc<Devices>,
}

struct Devices {
    store: Store,
    page: adw::NavigationPage,
    error: gtk::Label,
    list: adw::PreferencesGroup,
    rows: RefCell<Vec<gtk::Widget>>,
}

impl DevicesPage {
    pub fn new(store: &Store) -> DevicesPage {
        let error = error_label();
        let list = adw::PreferencesGroup::new();
        list.add(&error);
        let prefs = adw::PreferencesPage::new();
        prefs.add(&list);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&adw::HeaderBar::new());
        view.set_content(Some(&prefs));
        let page = adw::NavigationPage::builder()
            .title("Signed-in devices")
            .child(&view)
            .build();
        let d = Rc::new(Devices {
            store: store.clone(),
            page: page.clone(),
            error,
            list,
            rows: RefCell::default(),
        });
        d.load();
        DevicesPage { page, _inner: d }
    }
}

impl Devices {
    fn load(self: &Rc<Self>) {
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.devices().await;
            let Some(d) = weak.upgrade() else { return };
            match result {
                Ok(list) => {
                    d.error.set_visible(false);
                    d.show(&list);
                }
                Err(e) => d.show_error(&e.message),
            }
        });
    }

    fn show_error(&self, text: &str) {
        self.error.set_label(text);
        self.error.set_visible(true);
    }

    fn show(self: &Rc<Self>, list: &[Device]) {
        for r in self.rows.borrow_mut().drain(..) {
            self.list.remove(&r);
        }
        let mut rows = self.rows.borrow_mut();
        if list.is_empty() {
            let n = note("Nothing is signed in with a token.");
            self.list.add(&n);
            rows.push(n.upcast());
        }
        for dev in list {
            let used = match &dev.last_used_at {
                Some(at) => format!("last used {}", format::stamp(at)),
                None => "never used".into(),
            };
            let row = adw::ActionRow::builder()
                .title(&dev.name)
                .subtitle(format!("Added {}, {used}", format::stamp(&dev.created_at)))
                .use_markup(false)
                .build();
            let revoke = gtk::Button::builder()
                .label("Revoke")
                .valign(gtk::Align::Center)
                .css_classes(["flat", "error"])
                .build();
            let (weak, dev) = (Rc::downgrade(self), dev.clone());
            revoke.connect_clicked(move |_| {
                if let Some(d) = weak.upgrade() {
                    d.ask_revoke(&dev);
                }
            });
            row.add_suffix(&revoke);
            self.list.add(&row);
            rows.push(row.upcast());
        }
    }

    fn ask_revoke(self: &Rc<Self>, dev: &Device) {
        let dialog = adw::AlertDialog::new(
            Some(&format!("Revoke “{}”?", dev.name)),
            Some("It's signed out. If it's this computer, you'll need to sign in again."),
        );
        dialog.add_responses(&[("cancel", "Cancel"), ("go", "Revoke")]);
        dialog.set_response_appearance("go", adw::ResponseAppearance::Destructive);
        dialog.set_close_response("cancel");
        let (weak, id) = (Rc::downgrade(self), dev.id);
        dialog.connect_response(Some("go"), move |_, _| {
            let Some(d) = weak.upgrade() else { return };
            let (weak, store) = (Rc::downgrade(&d), d.store.clone());
            glib::spawn_future_local(async move {
                let result = store.revoke_device(id).await;
                let Some(d) = weak.upgrade() else { return };
                match result {
                    Ok(()) => d.load(),
                    Err(e) => d.show_error(&e.message),
                }
            });
        });
        dialog.present(Some(&self.page));
    }
}
