// A bot's page and a group's (BotView and GroupView on iOS).
use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};

use adw::prelude::*;
use gtk::glib;
use hatbot::core::format;
use hatbot::core::links::Link;
use hatbot::core::models::{
    BOT_COLORS, BOT_ICONS, Bot, BotChange, CHAT_EFFORTS, CHAT_MODELS, ConversationKind,
    GroupChange, HATBOT_ID, MAX_GROUP_BOTS, PluginName,
};
use hatbot::store::{Change, Listener, Store};

use super::form::{Choice, TextArea, confirm, error_label, nav_row, note};
use super::icon::Icon;
use super::route;

/// What the bot form holds; a new bot's is what you've written since the last template.
#[derive(Clone, PartialEq, Default)]
struct BotForm {
    name: String,
    icon: String,
    color: String,
    instructions: String,
    chat_model: Option<String>,
    chat_effort: Option<String>,
    plugins: Option<Vec<String>>,
}

impl BotForm {
    fn of(b: &Bot) -> BotForm {
        BotForm {
            name: b.name.clone(),
            icon: b.icon.clone(),
            color: b.color.clone(),
            instructions: b.instructions.clone(),
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
            instructions: self.instructions.clone(),
            chat_model: self.chat_model.clone(),
            chat_effort: self.chat_effort.clone(),
            plugins: self.plugins.clone(),
        }
    }
}

pub struct BotPage {
    pub page: adw::NavigationPage,
    _inner: Rc<BotEditor>,
    _listener: Listener,
}

struct BotEditor {
    store: Store,
    id: RefCell<Option<String>>,
    page: adw::NavigationPage,
    save: gtk::Button,
    error: gtk::Label,
    template: Rc<Choice>,
    name: adw::EntryRow,
    icons: Vec<(String, gtk::Button, Icon)>,
    colors: Vec<(String, gtk::Button)>,
    role: TextArea,
    model: Rc<Choice>,
    effort: Rc<Choice>,
    plugins_group: adw::PreferencesGroup,
    every_plugin: adw::SwitchRow,
    plugin_rows: RefCell<Vec<(String, adw::SwitchRow)>>,
    notes: adw::PreferencesGroup,
    delete_group: adw::PreferencesGroup,
    delete: adw::ButtonRow,
    icon: RefCell<String>,
    color: RefCell<String>,
    plugins: RefCell<Option<Vec<String>>>,
    templates: RefCell<Vec<Bot>>,
    /// The template picked, "" for none.
    picked: RefCell<String>,
    /// The form as the last template left it: anything else is yours, and asked about first.
    filled: RefCell<BotForm>,
    saved: RefCell<Option<BotForm>>,
    filling: Cell<bool>,
    busy: Cell<bool>,
}

fn card_row(child: &impl IsA<gtk::Widget>) -> gtk::ListBoxRow {
    gtk::ListBoxRow::builder()
        .activatable(false)
        .selectable(false)
        .child(child)
        .build()
}

fn flow() -> gtk::FlowBox {
    gtk::FlowBox::builder()
        .selection_mode(gtk::SelectionMode::None)
        .homogeneous(true)
        .max_children_per_line(17)
        .min_children_per_line(4)
        .row_spacing(4)
        .column_spacing(4)
        .margin_top(8)
        .margin_bottom(8)
        .margin_start(8)
        .margin_end(8)
        .build()
}

fn model_choices(current: Option<&str>) -> Vec<(String, String)> {
    let mut out = vec![(String::new(), "As in Settings".to_string())];
    let mut known: Vec<&str> = CHAT_MODELS.to_vec();
    if let Some(c) = current.filter(|c| !known.contains(c)) {
        known.push(c);
    }
    out.extend(known.iter().map(|m| (m.to_string(), format::model_name(m))));
    out
}

fn effort_choices(current: Option<&str>) -> Vec<(String, String)> {
    let mut out = vec![(String::new(), "As in Settings".to_string())];
    let mut known: Vec<&str> = CHAT_EFFORTS.to_vec();
    if let Some(c) = current.filter(|c| !known.contains(c)) {
        known.push(c);
    }
    out.extend(known.iter().map(|e| {
        let name = match *e {
            "xhigh" => "Extra high".to_string(),
            e => {
                let mut c = e.chars();
                c.next()
                    .map_or(String::new(), |f| f.to_uppercase().chain(c).collect())
            }
        };
        (e.to_string(), name)
    }));
    out
}

fn some(v: String) -> Option<String> {
    (!v.is_empty()).then_some(v)
}

impl BotPage {
    /// A bot's page; None for a new one.
    pub fn new(store: &Store, id: Option<&str>) -> BotPage {
        let save = gtk::Button::builder()
            .label(if id.is_some() { "Save" } else { "Create" })
            .css_classes(["suggested-action"])
            .sensitive(false)
            .build();
        let header = adw::HeaderBar::new();
        header.pack_end(&save);
        let prefs = adw::PreferencesPage::new();
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        view.set_content(Some(&prefs));
        let page = adw::NavigationPage::builder()
            .title("New bot")
            .child(&view)
            .build();

        let e = Rc::new_cyclic(|weak: &Weak<BotEditor>| {
            let changed = {
                let weak = weak.clone();
                move || {
                    if let Some(e) = weak.upgrade() {
                        e.sync();
                    }
                }
            };
            let template = Choice::new("Template", {
                let weak = weak.clone();
                move |key| {
                    if let Some(e) = weak.upgrade() {
                        e.pick_template(key);
                    }
                }
            });
            let model = Choice::new("Model", {
                let changed = changed.clone();
                move |_| changed()
            });
            let effort = Choice::new("Effort", {
                let changed = changed.clone();
                move |_| changed()
            });
            let name = adw::EntryRow::builder().title("Name").build();
            name.connect_changed({
                let changed = changed.clone();
                move |_| changed()
            });
            let role = TextArea::new(
                "Plans the week's meals around what's in the fridge. Keeps the shopping list.",
            );
            role.view.buffer().connect_changed({
                let changed = changed.clone();
                move |_| changed()
            });

            let icon_flow = flow();
            let icons: Vec<(String, gtk::Button, Icon)> = BOT_ICONS
                .iter()
                .map(|n| {
                    let icon = Icon::bot(n, "amber", 22);
                    let b = gtk::Button::builder()
                        .child(&icon)
                        .tooltip_text(*n)
                        .css_classes(["flat", "pick"])
                        .build();
                    let (weak, name) = (weak.clone(), n.to_string());
                    b.connect_clicked(move |_| {
                        if let Some(e) = weak.upgrade() {
                            e.icon.replace(name.clone());
                            e.sync();
                        }
                    });
                    icon_flow.append(&b);
                    (n.to_string(), b, icon)
                })
                .collect();
            let color_flow = flow();
            let colors: Vec<(String, gtk::Button)> = BOT_COLORS
                .iter()
                .map(|c| {
                    let swatch = gtk::Box::builder()
                        .css_classes(["swatch", &format!("bot-{c}")])
                        .halign(gtk::Align::Center)
                        .valign(gtk::Align::Center)
                        .build();
                    let b = gtk::Button::builder()
                        .child(&swatch)
                        .tooltip_text(*c)
                        .css_classes(["flat", "pick"])
                        .build();
                    let (weak, name) = (weak.clone(), c.to_string());
                    b.connect_clicked(move |_| {
                        if let Some(e) = weak.upgrade() {
                            e.color.replace(name.clone());
                            e.sync();
                        }
                    });
                    color_flow.append(&b);
                    (c.to_string(), b)
                })
                .collect();

            let error = error_label();
            let top = adw::PreferencesGroup::new();
            top.add(&error);
            prefs.add(&top);
            let first = adw::PreferencesGroup::new();
            first.add(&template.row);
            first.add(&name);
            prefs.add(&first);
            let icon_group = adw::PreferencesGroup::builder().title("Icon").build();
            icon_group.add(&card_row(&icon_flow));
            prefs.add(&icon_group);
            let color_group = adw::PreferencesGroup::builder().title("Colour").build();
            color_group.add(&card_row(&color_flow));
            prefs.add(&color_group);
            let role_group = adw::PreferencesGroup::builder().title("Role").build();
            role_group.add(&role.root);
            prefs.add(&role_group);
            let model_group = adw::PreferencesGroup::new();
            model_group.add(&model.row);
            model_group.add(&effort.row);
            prefs.add(&model_group);

            let plugins_group = adw::PreferencesGroup::builder()
                .title("Plugins")
                .visible(false)
                .build();
            let every_plugin = adw::SwitchRow::builder()
                .title("Every plugin that's on")
                .active(true)
                .build();
            every_plugin.connect_active_notify({
                let weak = weak.clone();
                move |row| {
                    let Some(e) = weak.upgrade() else { return };
                    if e.filling.get() {
                        return;
                    }
                    // Turned off, every plugin starts ticked.
                    let all = (!row.is_active()).then(|| {
                        e.plugin_rows
                            .borrow()
                            .iter()
                            .map(|(id, _)| id.clone())
                            .collect()
                    });
                    e.plugins.replace(all);
                    e.sync();
                }
            });
            plugins_group.add(&every_plugin);
            prefs.add(&plugins_group);

            let notes = adw::PreferencesGroup::builder().visible(false).build();
            notes.add(&nav_row("Its notes", {
                let weak = weak.clone();
                move || {
                    if let Some(id) = weak.upgrade().and_then(|e| e.id.borrow().clone()) {
                        route::go(Link::Memory(format!("bots/{id}/INDEX.md")));
                    }
                }
            }));
            prefs.add(&notes);
            let delete_group = adw::PreferencesGroup::builder().visible(false).build();
            let delete = adw::ButtonRow::new();
            // Not the builder's css_classes: they would drop the row's own "button".
            delete.add_css_class("destructive-action");
            delete.connect_activated({
                let weak = weak.clone();
                move |_| {
                    if let Some(e) = weak.upgrade() {
                        e.ask_delete();
                    }
                }
            });
            delete_group.add(&delete);
            delete_group.add(&note(
                "Its chat goes away. Its notes stay in Memory, and its schedules, triggers and \
                 watchers go to Hatbot, switched off until you turn them back on. If the heartbeat \
                 runs as it, it's switched off too.",
            ));
            prefs.add(&delete_group);

            BotEditor {
                store: store.clone(),
                id: RefCell::new(id.map(str::to_string)),
                page: page.clone(),
                save: save.clone(),
                error,
                template,
                name,
                icons,
                colors,
                role,
                model,
                effort,
                plugins_group,
                every_plugin,
                plugin_rows: RefCell::default(),
                notes,
                delete_group,
                delete,
                icon: RefCell::new("sparkles".into()),
                color: RefCell::new("amber".into()),
                plugins: RefCell::default(),
                templates: RefCell::default(),
                picked: RefCell::default(),
                filled: RefCell::default(),
                saved: RefCell::default(),
                filling: Cell::new(false),
                busy: Cell::new(false),
            }
        });
        let weak = Rc::downgrade(&e);
        save.connect_clicked(move |_| {
            if let Some(e) = weak.upgrade() {
                e.submit();
            }
        });
        // Shown once there are templates, for a new bot.
        e.template.row.set_visible(false);
        match e.stored() {
            Some(b) => e.show_bot(&b),
            None => e.fill(""),
        }
        e.load();
        let weak = Rc::downgrade(&e);
        let listener = store.listen(move |change| {
            let Some(e) = weak.upgrade() else { return };
            // Changed elsewhere: shown, unless you're changing it here.
            if matches!(change, Change::Chats)
                && !e.busy.get()
                && let Some(b) = e.stored()
                && e.saved.borrow().as_ref() == Some(&e.form())
                && e.saved.borrow().as_ref() != Some(&BotForm::of(&b))
            {
                e.show_bot(&b);
            }
        });
        BotPage {
            page,
            _inner: e,
            _listener: listener,
        }
    }
}

impl BotEditor {
    fn stored(&self) -> Option<Bot> {
        let id = self.id.borrow().clone()?;
        self.store.state().bots.get(&id).cloned()
    }

    fn is_hatbot(&self) -> bool {
        self.id.borrow().as_deref() == Some(HATBOT_ID)
    }

    fn form(&self) -> BotForm {
        BotForm {
            name: self.name.text().to_string(),
            icon: self.icon.borrow().clone(),
            color: self.color.borrow().clone(),
            instructions: self.role.text(),
            chat_model: some(self.model.value()),
            chat_effort: some(self.effort.value()),
            plugins: self.plugins.borrow().clone(),
        }
    }

    fn set_form(&self, f: &BotForm) {
        self.filling.set(true);
        self.name.set_text(&f.name);
        self.icon.replace(f.icon.clone());
        self.color.replace(f.color.clone());
        self.role.set_text(&f.instructions);
        self.model.set(
            &model_choices(f.chat_model.as_deref()),
            f.chat_model.as_deref().unwrap_or(""),
        );
        self.effort.set(
            &effort_choices(f.chat_effort.as_deref()),
            f.chat_effort.as_deref().unwrap_or(""),
        );
        self.plugins.replace(f.plugins.clone());
        self.filling.set(false);
        self.sync();
    }

    fn show_bot(&self, b: &Bot) {
        let f = BotForm::of(b);
        self.set_form(&f);
        self.saved.replace(Some(f));
        let hatbot = self.is_hatbot();
        self.page.set_title(&b.name);
        self.name.set_editable(!hatbot);
        self.name.set_sensitive(!hatbot);
        self.notes.set_visible(!hatbot);
        self.delete_group.set_visible(!hatbot);
        self.delete.set_title(&format!("Delete {}", b.name));
        self.sync();
    }

    /// The colour fewest bots have, the first of those in the list.
    fn free_color(&self) -> String {
        let st = self.store.state();
        BOT_COLORS
            .iter()
            .min_by_key(|c| st.bots.values().filter(|b| b.color == **c).count())
            .unwrap_or(&"amber")
            .to_string()
    }

    fn fill(&self, key: &str) {
        self.picked.replace(key.to_string());
        let t = self
            .templates
            .borrow()
            .iter()
            .find(|t| t.id == key)
            .cloned();
        let f = match t {
            Some(t) => BotForm::of(&t),
            None => BotForm {
                icon: "sparkles".into(),
                color: self.free_color(),
                ..BotForm::default()
            },
        };
        self.set_form(&f);
        self.filled.replace(f);
    }

    fn pick_template(self: &Rc<Self>, key: &str) {
        if *self.filled.borrow() == self.form() {
            self.fill(key);
            return;
        }
        let dialog = adw::AlertDialog::new(Some("Replace what you've written?"), None);
        let go = if key.is_empty() {
            "Clear it"
        } else {
            "Use the template"
        };
        dialog.add_responses(&[("keep", "Keep mine"), ("go", go)]);
        dialog.set_response_appearance("go", adw::ResponseAppearance::Destructive);
        dialog.set_close_response("keep");
        let (weak, key) = (Rc::downgrade(self), key.to_string());
        dialog.connect_response(None, move |_, response| {
            let Some(e) = weak.upgrade() else { return };
            if response == "go" {
                e.fill(&key);
            } else {
                // Back to the one you had.
                let picked = e.picked.borrow().clone();
                e.template.set(&e.template_choices(), &picked);
            }
        });
        dialog.present(Some(&self.page));
    }

    fn template_choices(&self) -> Vec<(String, String)> {
        let mut out = vec![(String::new(), "None".to_string())];
        out.extend(
            self.templates
                .borrow()
                .iter()
                .map(|t| (t.id.clone(), t.name.clone())),
        );
        out
    }

    fn load(self: &Rc<Self>) {
        let (weak, store, new) = (
            Rc::downgrade(self),
            self.store.clone(),
            self.id.borrow().is_none(),
        );
        glib::spawn_future_local(async move {
            let templates = if new {
                store.bot_templates().await
            } else {
                vec![]
            };
            let plugins = store.plugin_names().await;
            let Some(e) = weak.upgrade() else { return };
            if !templates.is_empty() {
                e.templates.replace(templates);
                let picked = e.picked.borrow().clone();
                e.template.set(&e.template_choices(), &picked);
                e.template.row.set_visible(true);
            }
            e.show_plugins(&plugins);
        });
    }

    fn show_plugins(self: &Rc<Self>, list: &[PluginName]) {
        self.plugins_group.set_visible(!list.is_empty());
        let mut rows = self.plugin_rows.borrow_mut();
        for p in list {
            let row = adw::SwitchRow::builder().title(&p.name).build();
            let (weak, id) = (Rc::downgrade(self), p.id.clone());
            row.connect_active_notify(move |row| {
                let Some(e) = weak.upgrade() else { return };
                if e.filling.get() {
                    return;
                }
                if let Some(list) = e.plugins.borrow_mut().as_mut() {
                    list.retain(|p| *p != id);
                    if row.is_active() {
                        list.push(id.clone());
                    }
                }
                e.sync();
            });
            self.plugins_group.add(&row);
            rows.push((p.id.clone(), row));
        }
        drop(rows);
        self.sync();
    }

    fn sync(&self) {
        if self.filling.get() {
            return;
        }
        let f = self.form();
        for (n, b, icon) in &self.icons {
            icon.set_bot(n, &f.color);
            if *n == f.icon {
                b.add_css_class("picked");
            } else {
                b.remove_css_class("picked");
            }
        }
        for (c, b) in &self.colors {
            if *c == f.color {
                b.add_css_class("picked");
            } else {
                b.remove_css_class("picked");
            }
        }
        self.filling.set(true);
        self.every_plugin.set_active(f.plugins.is_none());
        for (id, row) in self.plugin_rows.borrow().iter() {
            row.set_visible(f.plugins.is_some());
            row.set_active(f.plugins.as_ref().is_some_and(|l| l.contains(id)));
        }
        self.filling.set(false);
        let changed = self.saved.borrow().as_ref() != Some(&f);
        self.save
            .set_sensitive(!self.busy.get() && changed && !f.name.trim().is_empty());
    }

    fn show_error(&self, text: &str) {
        self.error.set_label(text);
        self.error.set_visible(true);
    }

    fn submit(self: &Rc<Self>) {
        let f = self.form();
        self.busy.set(true);
        self.sync();
        let (weak, store, id) = (
            Rc::downgrade(self),
            self.store.clone(),
            self.id.borrow().clone(),
        );
        let rename = !self.is_hatbot();
        glib::spawn_future_local(async move {
            let result = match &id {
                Some(id) => store.update_bot(id, &f.change(rename)).await,
                None => store.create_bot(&f.change(true)).await,
            };
            let Some(e) = weak.upgrade() else { return };
            e.busy.set(false);
            match result {
                Ok(b) => {
                    e.error.set_visible(false);
                    if id.is_some() {
                        e.show_bot(&b);
                        store.toast("Saved");
                    } else {
                        store.toast(&format!("Made {}", b.name));
                        if let Some(chat) = store.bot_chat(&b.id) {
                            route::chat(chat);
                        } else {
                            e.id.replace(Some(b.id.clone()));
                            e.show_bot(&b);
                        }
                    }
                }
                Err(err) => {
                    e.show_error(&err.message);
                    e.sync();
                }
            }
        });
    }

    fn ask_delete(self: &Rc<Self>) {
        let Some(id) = self.id.borrow().clone() else {
            return;
        };
        let name = self.stored().map_or("this bot".into(), |b| b.name);
        let weak = Rc::downgrade(self);
        confirm(
            &self.page,
            &format!("Delete {name}?"),
            "Delete",
            move || {
                let Some(e) = weak.upgrade() else { return };
                let (store, id, weak) = (e.store.clone(), id.clone(), weak.clone());
                glib::spawn_future_local(async move {
                    let result = store.delete_bot(&id).await;
                    let Some(e) = weak.upgrade() else { return };
                    match result {
                        Ok(()) => pop(&e.page),
                        Err(err) => e.show_error(&err.message),
                    }
                });
            },
        );
    }
}

fn pop(page: &adw::NavigationPage) {
    if let Some(nav) = page
        .ancestor(adw::NavigationView::static_type())
        .and_downcast::<adw::NavigationView>()
    {
        nav.pop();
    }
}

pub struct GroupPage {
    pub page: adw::NavigationPage,
    _inner: Rc<GroupEditor>,
    _listener: Listener,
}

struct GroupEditor {
    store: Store,
    id: Option<i64>,
    page: adw::NavigationPage,
    save: gtk::Button,
    error: gtk::Label,
    name: adw::EntryRow,
    bots: adw::PreferencesGroup,
    rows: RefCell<Vec<(String, adw::SwitchRow)>>,
    /// In the order they were ticked.
    members: RefCell<Vec<String>>,
    saved: RefCell<Option<GroupChange>>,
    filling: Cell<bool>,
    busy: Cell<bool>,
}

impl GroupPage {
    /// A group's page; None for a new one.
    pub fn new(store: &Store, id: Option<i64>) -> GroupPage {
        let save = gtk::Button::builder()
            .label(if id.is_some() { "Save" } else { "Create" })
            .css_classes(["suggested-action"])
            .sensitive(false)
            .build();
        let header = adw::HeaderBar::new();
        header.pack_end(&save);
        let prefs = adw::PreferencesPage::new();
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        view.set_content(Some(&prefs));
        let page = adw::NavigationPage::builder()
            .title("New group")
            .child(&view)
            .build();
        let error = error_label();
        let top = adw::PreferencesGroup::new();
        top.add(&error);
        prefs.add(&top);
        let name = adw::EntryRow::builder().title("Name").build();
        let first = adw::PreferencesGroup::new();
        first.add(&name);
        prefs.add(&first);
        let bots = adw::PreferencesGroup::builder()
            .title(format!("Bots, 2 to {MAX_GROUP_BOTS}"))
            .build();
        prefs.add(&bots);
        let delete_group = adw::PreferencesGroup::builder()
            .visible(id.is_some())
            .build();
        let delete = adw::ButtonRow::builder().title("Delete group").build();
        // Not the builder's css_classes: they would drop the row's own "button".
        delete.add_css_class("destructive-action");
        delete_group.add(&delete);
        prefs.add(&delete_group);

        let g = Rc::new(GroupEditor {
            store: store.clone(),
            id,
            page: page.clone(),
            save: save.clone(),
            error,
            name: name.clone(),
            bots,
            rows: RefCell::default(),
            members: RefCell::default(),
            saved: RefCell::default(),
            filling: Cell::new(false),
            busy: Cell::new(false),
        });
        let weak = Rc::downgrade(&g);
        name.connect_changed(move |_| {
            if let Some(g) = weak.upgrade() {
                g.sync();
            }
        });
        let weak = Rc::downgrade(&g);
        save.connect_clicked(move |_| {
            if let Some(g) = weak.upgrade() {
                g.submit();
            }
        });
        let weak = Rc::downgrade(&g);
        delete.connect_activated(move |_| {
            if let Some(g) = weak.upgrade() {
                g.ask_delete();
            }
        });
        g.show_bots();
        if let Some(c) = g.stored() {
            g.filling.set(true);
            g.name.set_text(c.title.as_deref().unwrap_or(""));
            g.filling.set(false);
            g.members.replace(c.bot_ids.clone());
            g.saved.replace(Some(GroupChange {
                title: c.title.clone().unwrap_or_default(),
                bot_ids: c.bot_ids.clone(),
            }));
            g.page.set_title(&g.store.state().chat_name(Some(&c)));
        }
        g.sync();
        let weak = Rc::downgrade(&g);
        let listener = store.listen(move |change| {
            if matches!(change, Change::Chats)
                && let Some(g) = weak.upgrade()
            {
                g.show_bots();
                g.sync();
            }
        });
        GroupPage {
            page,
            _inner: g,
            _listener: listener,
        }
    }
}

impl GroupEditor {
    fn stored(&self) -> Option<hatbot::core::models::Conversation> {
        let id = self.id?;
        self.store
            .state()
            .conversations
            .iter()
            .find(|c| c.id == id && c.kind == ConversationKind::Group)
            .cloned()
    }

    fn show_bots(self: &Rc<Self>) {
        let st = self.store.state();
        let ids: Vec<String> = st.bot_ids.clone();
        if self.rows.borrow().iter().map(|(id, _)| id).eq(ids.iter()) {
            return;
        }
        for (_, row) in self.rows.borrow_mut().drain(..) {
            self.bots.remove(&row);
        }
        let mut rows = self.rows.borrow_mut();
        for id in ids {
            let row = adw::SwitchRow::builder()
                .title(st.bot_name(Some(&id)))
                .use_markup(false)
                .build();
            let (weak, bot) = (Rc::downgrade(self), id.clone());
            row.connect_active_notify(move |row| {
                let Some(g) = weak.upgrade() else { return };
                if g.filling.get() {
                    return;
                }
                {
                    let mut m = g.members.borrow_mut();
                    m.retain(|b| *b != bot);
                    if row.is_active() {
                        m.push(bot.clone());
                    }
                }
                g.sync();
            });
            self.bots.add(&row);
            rows.push((id, row));
        }
    }

    fn change(&self) -> GroupChange {
        GroupChange {
            title: self.name.text().trim().to_string(),
            bot_ids: self.members.borrow().clone(),
        }
    }

    fn sync(&self) {
        if self.filling.get() {
            return;
        }
        self.filling.set(true);
        let members = self.members.borrow().clone();
        for (id, row) in self.rows.borrow().iter() {
            row.set_active(members.contains(id));
        }
        self.filling.set(false);
        let c = self.change();
        let changed = self.saved.borrow().as_ref() != Some(&c);
        let valid = (2..=MAX_GROUP_BOTS).contains(&c.bot_ids.len());
        self.save
            .set_sensitive(!self.busy.get() && changed && valid);
    }

    fn submit(self: &Rc<Self>) {
        let c = self.change();
        self.busy.set(true);
        self.sync();
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = match id {
                Some(id) => store.update_group(id, &c).await,
                None => store.create_group(&c).await,
            };
            let Some(g) = weak.upgrade() else { return };
            g.busy.set(false);
            match result {
                Ok(chat) if id.is_some() => {
                    g.error.set_visible(false);
                    g.saved.replace(Some(GroupChange {
                        title: chat.title.clone().unwrap_or_default(),
                        bot_ids: chat.bot_ids.clone(),
                    }));
                    g.page.set_title(&store.state().chat_name(Some(&chat)));
                    store.toast("Saved");
                    g.sync();
                }
                Ok(chat) => route::chat(chat.id),
                Err(err) => {
                    g.error.set_label(&err.message);
                    g.error.set_visible(true);
                    g.sync();
                }
            }
        });
    }

    fn ask_delete(self: &Rc<Self>) {
        let Some(id) = self.id else { return };
        let name = self.store.state().chat_name(self.stored().as_ref());
        let weak = Rc::downgrade(self);
        confirm(
            &self.page,
            &format!("Delete {name}? Its messages go with it."),
            "Delete",
            move || {
                let Some(g) = weak.upgrade() else { return };
                let (store, weak) = (g.store.clone(), weak.clone());
                glib::spawn_future_local(async move {
                    let result = store.delete_group(id).await;
                    let Some(g) = weak.upgrade() else { return };
                    match result {
                        Ok(()) => pop(&g.page),
                        Err(err) => {
                            g.error.set_label(&err.message);
                            g.error.set_visible(true);
                        }
                    }
                });
            },
        );
    }
}
