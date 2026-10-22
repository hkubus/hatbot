// Each switch, picker and limit saves on its own.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use hatbot::core::format;
use hatbot::core::looking::{self, dollars_text};
use hatbot::core::models::{AppSettings, Device, Limits};
use hatbot::store::{Change, Listener, Store};
use serde_json::{Value, json};

use super::form::{Choice, error_label, nav_row, note};
use super::looking::ChecksPage;
use super::route;
use super::shell::Banners;

/// Whether a group's settings came from the brain.
type Shown = fn(&AppSettings) -> bool;

pub struct Settings {
    pub page: adw::NavigationPage,
    inner: Rc<Root>,
    _listener: Listener,
}

struct Root {
    store: Store,
    error: gtk::Label,
    pause: adw::SwitchRow,
    chat_model: Rc<Choice>,
    chat_effort: Rc<Choice>,
    task_model: Rc<Choice>,
    desktop_model: Rc<Choice>,
    escalate: adw::SwitchRow,
    limits: Vec<(adw::EntryRow, &'static str)>,
    more: adw::ExpanderRow,
    opens: Rc<Choice>,
    test_row: adw::ActionRow,
    test: gtk::Button,
    approval: Cell<Option<i64>>,
    review: adw::SwitchRow,
    groups: Vec<(adw::PreferencesGroup, Shown)>,
    settings: RefCell<Option<AppSettings>>,
    /// Saves on their way: a load meanwhile would put back what they change.
    saving: Cell<u32>,
    syncing: Cell<bool>,
    /// Spend's Limits: the limits get focus once they show.
    to_spending: Cell<bool>,
}

const LIMITS: [(&str, &str); 2] = [("dailyUsd", "Per day"), ("monthlyUsd", "Per month")];
const MORE_LIMITS: [(&str, &str); 4] = [
    ("taskUsd", "Per task"),
    ("researchUsd", "Per research task"),
    ("boxesUsd", "Boxes per day"),
    ("alertReserveUsd", "Kept for alerts"),
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

fn limit_row(title: &str) -> adw::EntryRow {
    let row = adw::EntryRow::builder()
        .title(title)
        .input_purpose(gtk::InputPurpose::Number)
        .show_apply_button(true)
        .build();
    row.add_prefix(&gtk::Label::new(Some("$")));
    row
}

impl Settings {
    pub fn new(store: &Store, banners: &Banners) -> Settings {
        let error = error_label();
        let top = adw::PreferencesGroup::new();
        top.add(&error);
        let models = adw::PreferencesGroup::builder().title("Models").build();
        let spending = adw::PreferencesGroup::builder().title("Spending").build();
        let notifications = adw::PreferencesGroup::builder()
            .title("Notifications")
            .build();
        let safety = adw::PreferencesGroup::builder().title("Safety").build();

        let account = adw::PreferencesGroup::builder().title("Account").build();
        let server = adw::ActionRow::builder().title("Server").build();
        server.add_suffix(
            &gtk::Label::builder()
                .label(
                    glib::Uri::parse(store.api().server(), glib::UriFlags::NONE)
                        .ok()
                        .and_then(|u| u.host())
                        .map(|h| h.to_string())
                        .unwrap_or_default(),
                )
                .css_classes(["dim-label"])
                .build(),
        );
        account.add(&server);
        let s = store.clone();
        account.add(&nav_row("Devices and tokens", move || {
            let p = DevicesPage::new(&s);
            route::push(p.page.clone(), Box::new(p));
        }));
        let sign_out = adw::ActionRow::builder().title("Sign out").build();
        sign_out.add_suffix(
            &gtk::Button::builder()
                .label("Sign out")
                .valign(gtk::Align::Center)
                .action_name("win.sign-out")
                .build(),
        );
        account.add(&sign_out);

        let system = adw::PreferencesGroup::builder().title("System").build();
        let s = store.clone();
        system.add(&nav_row("Check everything", move || {
            let p = ChecksPage::new(&s);
            route::push(p.page.clone(), Box::new(p));
        }));

        let prefs = adw::PreferencesPage::new();
        for g in [
            &top,
            &models,
            &spending,
            &notifications,
            &safety,
            &account,
            &system,
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

        let test_row = adw::ActionRow::builder().title("Test approval").build();
        let test = gtk::Button::builder()
            .label("Send")
            .valign(gtk::Align::Center)
            .build();
        test_row.add_suffix(&test);
        let root = Rc::new_cyclic(|weak: &std::rc::Weak<Root>| {
            let pick = |key: &'static str| {
                let weak = weak.clone();
                move |v: &str| {
                    if let Some(r) = weak.upgrade() {
                        r.save(json!({ key: v }));
                    }
                }
            };
            Root {
                store: store.clone(),
                error,
                pause: adw::SwitchRow::builder()
                    .title("Pause all activity")
                    .build(),
                chat_model: Choice::new("Chat", pick("chatModel")),
                chat_effort: Choice::new("Chat effort", pick("chatEffort")),
                task_model: Choice::new("Background tasks", pick("taskModel")),
                desktop_model: Choice::new("Desktop tasks", pick("desktopModel")),
                escalate: adw::SwitchRow::builder()
                    .title("Try desktop tasks again on Opus when Haiku fails")
                    .build(),
                limits: LIMITS
                    .iter()
                    .chain(&MORE_LIMITS)
                    .map(|(key, title)| (limit_row(title), *key))
                    .collect(),
                more: adw::ExpanderRow::builder().title("More limits").build(),
                opens: Choice::new("Tapping one opens", pick("notificationsOpen")),
                test_row,
                test,
                approval: Cell::new(None),
                review: adw::SwitchRow::builder()
                    .title("Let a safety review allow safe changes without asking you")
                    .build(),
                groups: vec![
                    (models.clone(), |s| s.chat_model.is_some()),
                    (spending.clone(), |s| s.limits.is_some()),
                    (notifications.clone(), |s| s.notifications_open.is_some()),
                    (safety.clone(), |s| s.review_changes.is_some()),
                ],
                settings: RefCell::default(),
                saving: Cell::new(0),
                syncing: Cell::new(false),
                to_spending: Cell::new(false),
            }
        });
        top.add(&root.pause);
        // Haiku's name is long.
        root.chat_model.row.set_use_subtitle(true);
        models.add(&root.chat_model.row);
        models.add(&root.chat_effort.row);
        models.add(&root.task_model.row);
        models.add(&root.desktop_model.row);
        models.add(&root.escalate);
        for (i, (row, _)) in root.limits.iter().enumerate() {
            if i < LIMITS.len() {
                spending.add(row);
            } else {
                root.more.add_row(row);
            }
        }
        spending.add(&root.more);
        notifications.add(&root.opens.row);
        notifications.add(&root.test_row);
        safety.add(&root.review);
        root.connect();
        root.render_paused();

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
                Change::Paused => r.render_paused(),
                Change::NeedsYou => r.render_answer(),
                _ => {}
            }
        });
        Settings {
            page,
            inner: root,
            _listener: listener,
        }
    }

    /// Spend's Limits.
    pub fn show_spending(&self) {
        self.inner.to_spending.set(true);
        self.inner.focus_spending();
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
        switch(&self.escalate, "desktopEscalate");
        switch(&self.review, "reviewChanges");
        let weak = Rc::downgrade(self);
        self.pause.connect_active_notify(move |row| {
            let Some(r) = weak.upgrade() else { return };
            if r.syncing.get() {
                return;
            }
            let (weak, store, on) = (Rc::downgrade(&r), r.store.clone(), row.is_active());
            glib::spawn_future_local(async move {
                let result = store.set_paused(on).await;
                let Some(r) = weak.upgrade() else { return };
                match result {
                    Ok(()) => store.toast(if on { "All activity paused" } else { "Resumed" }),
                    Err(e) => r.show_error(&e.message),
                }
                r.render_paused();
            });
        });
        for (row, key) in &self.limits {
            let (weak, key) = (Rc::downgrade(self), *key);
            row.connect_apply(move |row| {
                if let Some(r) = weak.upgrade() {
                    r.save_limit(key, &row.text());
                }
            });
        }
        let weak = Rc::downgrade(self);
        self.test.connect_clicked(move |_| {
            if let Some(r) = weak.upgrade() {
                r.send_test();
            }
        });
    }

    fn show_error(&self, text: &str) {
        self.error.set_label(text);
        self.error.set_visible(true);
    }

    fn load(self: &Rc<Self>) {
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let (settings, checks) = futures_util::join!(store.load_settings(), store.checks());
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
            if let Ok(c) = checks
                && r.approval.get().is_none()
            {
                r.approval.set(c.approval.map(|a| a.id));
                r.render_answer();
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
                    store.toast("Saved");
                }
                Err(e) => r.show_error(&e.message),
            }
            // A failed save puts the control back.
            r.render();
        });
    }

    fn save_limit(self: &Rc<Self>, key: &'static str, text: &str) {
        let Some(old) = self
            .settings
            .borrow()
            .as_ref()
            .and_then(|s| s.limits.as_ref())
            .and_then(|l| limit_of(l, key))
        else {
            return;
        };
        // Nothing kept for alerts is allowed, and boxes asking nothing; a limit of nothing isn't.
        let zero = matches!(key, "alertReserveUsd" | "boxesUsd");
        match looking::limit(text, old) {
            None if zero => self.show_error("Give an amount, $0 or more."),
            None => self.show_error("Give an amount."),
            Some(v) if zero && v < 0.0 => self.show_error("It can't be below $0."),
            Some(v) if !zero && v <= 0.0 => self.show_error("A limit must be more than $0."),
            Some(v) if v == old => self.render(),
            Some(v) => self.save(json!({ "limits": { key: v } })),
        }
    }

    fn send_test(self: &Rc<Self>) {
        self.test.set_sensitive(false);
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.test_approval().await;
            let Some(r) = weak.upgrade() else { return };
            r.test.set_sensitive(true);
            match result {
                Ok(a) => {
                    r.approval.set(Some(a.id));
                    r.render_answer();
                }
                Err(e) => r.show_error(&e.message),
            }
        });
    }

    fn render_answer(&self) {
        let answer = self
            .approval
            .get()
            .and_then(|id| self.store.state().approvals.get(&id).map(looking::answer));
        self.test_row
            .set_subtitle(&glib::markup_escape_text(&answer.unwrap_or_default()));
    }

    fn render_paused(&self) {
        self.syncing.set(true);
        self.pause.set_active(self.store.state().paused);
        self.syncing.set(false);
    }

    fn focus_spending(&self) {
        if !self.to_spending.get() || self.settings.borrow().is_none() {
            return;
        }
        self.to_spending.set(false);
        let row = self.limits[0].0.clone();
        // After the page is in place, so it scrolls there.
        glib::idle_add_local_once(move || {
            row.grab_focus();
        });
    }

    fn render(&self) {
        let Some(s) = self.settings.borrow().clone() else {
            return;
        };
        self.syncing.set(true);
        for (group, shown) in &self.groups {
            group.set_visible(shown(&s));
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
        self.task_model.row.set_visible(s.task_model.is_some());
        if let Some(m) = &s.task_model {
            self.task_model.set(&looking::model_choices(m), m);
        }
        self.desktop_model
            .row
            .set_visible(s.desktop_model.is_some());
        if let Some(m) = &s.desktop_model {
            self.desktop_model.set(&looking::model_choices(m), m);
        }
        self.escalate.set_visible(
            s.desktop_escalate.is_some() && s.desktop_model.as_deref() == Some(looking::MODELS[0]),
        );
        self.escalate.set_active(s.desktop_escalate == Some(true));
        if let Some(l) = &s.limits {
            for (row, key) in &self.limits {
                let value = limit_of(l, key);
                row.set_visible(value.is_some());
                // Not over what you're typing.
                if !row.state_flags().contains(gtk::StateFlags::FOCUS_WITHIN) {
                    // Off while it's set, or the apply button shows as if you'd typed it.
                    row.set_show_apply_button(false);
                    row.set_text(&value.map(dollars_text).unwrap_or_default());
                    row.set_show_apply_button(true);
                }
            }
        }
        if let Some(o) = &s.notifications_open {
            let choices = [
                ("web".to_string(), "The web app".to_string()),
                ("app".to_string(), "This app".to_string()),
            ];
            self.opens.set(&looking::choices(&choices, o), o);
        }
        self.review.set_active(s.review_changes == Some(true));
        self.syncing.set(false);
        self.focus_spending();
    }
}

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
        let list = adw::PreferencesGroup::builder().title("API tokens").build();
        list.add(&error);
        let prefs = adw::PreferencesPage::new();
        prefs.add(&list);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&adw::HeaderBar::new());
        view.set_content(Some(&prefs));
        let page = adw::NavigationPage::builder()
            .title("Devices and tokens")
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
