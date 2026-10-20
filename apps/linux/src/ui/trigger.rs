// A trigger's page: its name and instructions, switches that save as you flip them, its address and a
// new secret (SchedulesView.swift on iOS). Triggers are made on the web.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use adw::prelude::*;
use gtk::{gdk, glib};
use hatbot::core::links::Link;
use hatbot::core::models::{Trigger, TriggerKind};
use hatbot::store::{Change, Listener, Store};
use serde_json::json;

use super::form::{TextArea, bot_row, confirm, error_label, note};
use super::route;

/// How long a copied secret stays on the clipboard.
const CLIPBOARD_SECONDS: u32 = 120;

pub struct TriggerPage {
    pub page: adw::NavigationPage,
    _inner: Rc<Page>,
    _listener: Listener,
}

struct Page {
    store: Store,
    id: i64,
    page: adw::NavigationPage,
    stack: gtk::Stack,
    save: gtk::Button,
    error: gtk::Label,
    secret: adw::PreferencesGroup,
    secret_note: gtk::Label,
    secret_value: gtk::Label,
    name: adw::EntryRow,
    on: adw::SwitchRow,
    bots: Option<(adw::ComboRow, Vec<String>)>,
    trusted: adw::SwitchRow,
    trusted_note: gtk::Label,
    checks: adw::ComboRow,
    prompt: TextArea,
    address: adw::ActionRow,
    last_run: adw::ActionRow,
    /// What's shown came from the brain; a switch flipped back after an error isn't yours.
    filling: Cell<bool>,
    filled: Cell<bool>,
    busy: Cell<bool>,
    shown_secret: RefCell<String>,
}

impl TriggerPage {
    pub fn new(store: &Store, id: i64) -> TriggerPage {
        let save = gtk::Button::builder()
            .label("Save")
            .css_classes(["suggested-action"])
            .build();
        let header = adw::HeaderBar::new();
        header.pack_end(&save);

        let error = error_label();
        let top = adw::PreferencesGroup::new();
        top.add(&error);

        let secret_note = note("");
        secret_note.set_margin_top(0);
        let secret_value = gtk::Label::builder()
            .xalign(0.0)
            .wrap(true)
            .wrap_mode(gtk::pango::WrapMode::Char)
            .hexpand(true)
            .css_classes(["monospace"])
            .build();
        let copy = gtk::Button::builder()
            .icon_name("edit-copy-symbolic")
            .tooltip_text("Copy")
            .valign(gtk::Align::Center)
            .css_classes(["flat"])
            .build();
        let value = gtk::Box::builder()
            .spacing(8)
            .css_classes(["card", "secret"])
            .build();
        value.append(&secret_value);
        value.append(&copy);
        let secret = adw::PreferencesGroup::builder()
            .title("New Secret")
            .visible(false)
            .build();
        secret.add(&secret_note);
        secret.add(&value);

        let name = adw::EntryRow::builder().title("Name").build();
        let on = adw::SwitchRow::builder().title("On").build();
        let bots = bot_row(store, "hatbot");
        let trusted = adw::SwitchRow::builder()
            .title("Trust its payloads")
            .visible(false)
            .build();
        let trusted_note = note("Untrusted payloads make the run ask before it changes anything.");
        trusted_note.set_visible(false);
        let checks = adw::ComboRow::builder()
            .title("Start a task after")
            .model(&gtk::StringList::new(&[
                "First failure",
                "2 failures",
                "3 failures",
            ]))
            .visible(false)
            .build();
        let main = adw::PreferencesGroup::new();
        main.add(&name);
        main.add(&on);
        if let Some((row, _)) = &bots {
            main.add(row);
        }
        main.add(&trusted);
        main.add(&checks);
        main.add(&trusted_note);

        let prompt = TextArea::new("Instructions");
        let what = adw::PreferencesGroup::builder()
            .title("What it does")
            .build();
        what.add(&prompt.root);

        let address = adw::ActionRow::builder()
            .subtitle_selectable(true)
            .use_markup(false)
            .css_classes(["property", "monospace-subtitle"])
            .build();
        let last_run = adw::ActionRow::builder()
            .title("Last run")
            .activatable(true)
            .visible(false)
            .build();
        last_run.add_suffix(&gtk::Image::from_icon_name("go-next-symbolic"));
        let new_secret = adw::ButtonRow::builder().title("New Secret").build();
        let info = adw::PreferencesGroup::new();
        info.add(&address);
        info.add(&last_run);
        info.add(&new_secret);
        let delete_row = adw::ButtonRow::builder().title("Delete Trigger").build();
        // Not the builder's css_classes: they would drop the row's own "button".
        delete_row.add_css_class("destructive-action");
        let delete = adw::PreferencesGroup::new();
        delete.add(&delete_row);

        let prefs = adw::PreferencesPage::new();
        for g in [&top, &secret, &main, &what, &info, &delete] {
            prefs.add(g);
        }
        let gone = adw::StatusPage::builder()
            .icon_name("dialog-question-symbolic")
            .title("This trigger doesn't exist.")
            .build();
        let stack = gtk::Stack::new();
        stack.add_named(&adw::Spinner::new(), Some("loading"));
        stack.add_named(&gone, Some("gone"));
        stack.add_named(&prefs, Some("form"));
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        view.set_content(Some(&stack));
        let page = adw::NavigationPage::builder()
            .title("Trigger")
            .child(&view)
            .build();

        let p = Rc::new(Page {
            store: store.clone(),
            id,
            page: page.clone(),
            stack,
            save,
            error,
            secret,
            secret_note,
            secret_value,
            name,
            on,
            bots,
            trusted,
            trusted_note,
            checks,
            prompt,
            address,
            last_run,
            filling: Cell::new(false),
            filled: Cell::new(false),
            busy: Cell::new(false),
            shown_secret: RefCell::default(),
        });
        p.connect(&copy, &new_secret, &delete_row);
        p.render();
        let weak = Rc::downgrade(&p);
        let listener = store.listen(move |change| {
            if let (Some(p), Change::Trigger(t)) = (weak.upgrade(), change)
                && *t == p.id
            {
                p.render();
            }
        });
        let weak = Rc::downgrade(&p);
        let store = store.clone();
        glib::spawn_future_local(async move {
            let result = store.load_trigger(id).await;
            let Some(p) = weak.upgrade() else { return };
            match result {
                Err(e) if e.status == 404 => p.stack.set_visible_child_name("gone"),
                Err(e) => {
                    p.show_error(&e.message);
                    p.stack.set_visible_child_name("form");
                }
                Ok(()) => {}
            }
        });
        TriggerPage {
            page,
            _inner: p,
            _listener: listener,
        }
    }
}

impl Page {
    fn connect(
        self: &Rc<Self>,
        copy: &gtk::Button,
        new_secret: &adw::ButtonRow,
        delete: &adw::ButtonRow,
    ) {
        let weak = Rc::downgrade(self);
        self.name.connect_changed(move |_| {
            if let Some(p) = weak.upgrade() {
                p.sync_save();
            }
        });
        let weak = Rc::downgrade(self);
        self.prompt.view.buffer().connect_changed(move |_| {
            if let Some(p) = weak.upgrade() {
                p.sync_save();
            }
        });
        // Switches and pickers save as soon as they change.
        let weak = Rc::downgrade(self);
        self.on.connect_active_notify(move |r| {
            if let Some(p) = weak.upgrade() {
                p.update(json!({"enabled": r.is_active()}));
            }
        });
        let weak = Rc::downgrade(self);
        self.trusted.connect_active_notify(move |r| {
            if let Some(p) = weak.upgrade() {
                p.update(json!({"trusted": r.is_active()}));
            }
        });
        let weak = Rc::downgrade(self);
        self.checks.connect_selected_notify(move |r| {
            if let Some(p) = weak.upgrade() {
                p.update(json!({"confirmChecks": r.selected()}));
            }
        });
        if let Some((row, ids)) = &self.bots {
            let (weak, ids) = (Rc::downgrade(self), ids.clone());
            row.connect_selected_notify(move |r| {
                if let (Some(p), Some(bot)) = (weak.upgrade(), ids.get(r.selected() as usize)) {
                    p.update(json!({"botId": bot}));
                }
            });
        }
        let weak = Rc::downgrade(self);
        self.save.connect_clicked(move |_| {
            if let Some(p) = weak.upgrade() {
                p.save();
            }
        });
        let weak = Rc::downgrade(self);
        self.last_run.connect_activated(move |_| {
            let Some(p) = weak.upgrade() else { return };
            let last = p
                .store
                .state()
                .triggers
                .get(&p.id)
                .and_then(|t| t.last_task_id);
            if let Some(task) = last {
                route::go(Link::Task(task));
            }
        });
        let weak = Rc::downgrade(self);
        copy.connect_clicked(move |b| {
            if let Some(p) = weak.upgrade() {
                copy_for_a_while(&b.clipboard(), &p.shown_secret.borrow());
            }
        });
        let weak = Rc::downgrade(self);
        new_secret.connect_activated(move |row| {
            let weak = weak.clone();
            confirm(
                row,
                "Replace the secret? The old one stops working right away.",
                "New Secret",
                move || {
                    if let Some(p) = weak.upgrade() {
                        p.new_secret();
                    }
                },
            );
        });
        let weak = Rc::downgrade(self);
        delete.connect_activated(move |row| {
            let Some(p) = weak.upgrade() else { return };
            let name = p.store.state().triggers.get(&p.id).map(|t| t.name.clone());
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

    fn trigger(&self) -> Option<Trigger> {
        self.store.state().triggers.get(&self.id).cloned()
    }

    /// The stored trigger. Its name and instructions fill in once; you may be editing them after.
    fn render(&self) {
        let Some(t) = self.trigger() else {
            if self.filled.get() {
                self.stack.set_visible_child_name("gone");
            }
            return;
        };
        self.stack.set_visible_child_name("form");
        self.page.set_title(&t.name);
        self.filling.set(true);
        if !self.filled.replace(true) {
            self.name.set_text(&t.name);
            self.prompt.set_text(&t.prompt);
        }
        self.on.set_active(t.enabled);
        if let Some((row, ids)) = &self.bots {
            row.set_selected(ids.iter().position(|b| *b == t.bot_id).unwrap_or(0) as u32);
        }
        let webhook = t.kind != TriggerKind::Kuma;
        self.trusted.set_visible(webhook);
        self.trusted_note.set_visible(webhook);
        self.trusted.set_active(t.trusted);
        self.checks
            .set_visible(!webhook && t.confirm_checks.is_some());
        self.checks
            .set_selected(t.confirm_checks.unwrap_or(0).clamp(0, 2) as u32);
        self.filling.set(false);
        self.address
            .set_title(if webhook { "Webhook" } else { "Uptime Kuma" });
        self.address.set_subtitle(&t.url);
        self.last_run.set_visible(t.last_task_id.is_some());
        self.sync_save();
    }

    fn sync_save(&self) {
        let Some(t) = self.trigger() else {
            self.save.set_sensitive(false);
            return;
        };
        let (name, prompt) = (self.name.text().to_string(), self.prompt.text());
        let changed = name != t.name || prompt != t.prompt;
        let filled = !name.trim().is_empty() && !prompt.trim().is_empty();
        self.save
            .set_sensitive(!self.busy.get() && changed && filled);
    }

    /// Saves one switch or picker; on an error it goes back to what the brain has.
    fn update(self: &Rc<Self>, change: serde_json::Value) {
        if self.filling.get() {
            return;
        }
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.update_trigger(id, &change).await;
            let Some(p) = weak.upgrade() else { return };
            match result {
                Ok(_) => p.error.set_visible(false),
                Err(e) => {
                    p.show_error(&e.message);
                    p.render();
                }
            }
        });
    }

    fn save(self: &Rc<Self>) {
        if self.busy.replace(true) {
            return;
        }
        self.sync_save();
        let change = json!({"name": self.name.text().as_str(), "prompt": self.prompt.text()});
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.update_trigger(id, &change).await;
            let Some(p) = weak.upgrade() else { return };
            p.busy.set(false);
            match result {
                Ok(t) => {
                    p.error.set_visible(false);
                    // The brain trims them.
                    p.name.set_text(&t.name);
                    p.prompt.set_text(&t.prompt);
                    store.toast("Saved");
                }
                Err(e) => p.show_error(&e.message),
            }
            p.sync_save();
        });
    }

    fn new_secret(self: &Rc<Self>) {
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.new_secret(id).await;
            let Some(p) = weak.upgrade() else { return };
            match result {
                Ok(t) => {
                    p.error.set_visible(false);
                    let kuma = t.trigger.kind == TriggerKind::Kuma;
                    let value = if kuma {
                        format!("{}?token={}", t.trigger.url, t.secret)
                    } else {
                        t.secret
                    };
                    p.secret_note.set_label(if kuma {
                        "Paste this Post URL into Uptime Kuma's Webhook notification. It holds the secret and isn't shown again."
                    } else {
                        "Use this as the webhook's secret. It isn't shown again."
                    });
                    p.secret_value.set_label(&value);
                    p.shown_secret.replace(value);
                    p.secret.set_visible(true);
                }
                Err(e) => p.show_error(&e.message),
            }
        });
    }

    fn delete(self: &Rc<Self>) {
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.delete_trigger(id).await;
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

/// Copies a secret, and takes it off the clipboard after a while if nothing replaced it.
fn copy_for_a_while(clipboard: &gdk::Clipboard, text: &str) {
    clipboard.set_text(text);
    let (clipboard, text) = (clipboard.clone(), text.to_string());
    glib::spawn_future_local(async move {
        glib::timeout_future_seconds(CLIPBOARD_SECONDS).await;
        if clipboard.read_text_future().await.ok().flatten().as_deref() == Some(text.as_str()) {
            clipboard.set_text("");
        }
    });
}
