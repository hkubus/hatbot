// Memory (PLAN.md §24.2 L5, MemoryView.swift on iOS): the files by folder, with proposals to look
// over and skills that went wrong; a file to read, edit and delete, with a bar for someone else's
// save in between; history, a commit's diff and Revert; and a proposal to apply or dismiss.
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use adw::prelude::*;
use gtk::{gdk, gio, glib};
use hatbot::core::format;
use hatbot::core::memory::{self, DiffKind, DiffLine};
use hatbot::core::models::{
    MemoryCommit, MemoryConflict, MemoryFile, ProposalKind, ProposalStatus, SkillStatus,
};
use hatbot::store::{Asked, Change, Listener, Store, conflict};

use super::form::{confirm, error_label, note};
use super::icon::Icon;
use super::markdown::Markdown;
use super::route;
use super::shell::Banners;

/// How long asking for a tidy-up or a fix waits for it to come.
const ASK_WAIT: Duration = Duration::from_secs(180);

pub struct Memory {
    pub page: adw::NavigationPage,
    _inner: Rc<Root>,
    _listener: Listener,
}

struct Root {
    store: Store,
    prefs: adw::PreferencesPage,
    error: gtk::Label,
    spinner: adw::Spinner,
    tidy: gtk::Button,
    groups: RefCell<Vec<adw::PreferencesGroup>>,
    files: RefCell<Option<Vec<MemoryFile>>>,
    skills: RefCell<Vec<SkillStatus>>,
    asking: RefCell<Option<Asking>>,
}

/// A tidy-up (no skill) or a skill's fix asked for: the first new proposal of its kind opens.
struct Asking {
    skill: Option<String>,
    before: Vec<i64>,
}

impl Memory {
    pub fn new(store: &Store, banners: &Banners) -> Memory {
        let history = gtk::Button::builder()
            .icon_name("document-open-recent-symbolic")
            .tooltip_text("History")
            .build();
        let new_file = gtk::Button::builder()
            .icon_name("list-add-symbolic")
            .tooltip_text("New File")
            .build();
        let tidy = gtk::Button::builder().label("Tidy Up").build();
        let header = adw::HeaderBar::new();
        header.pack_end(&new_file);
        header.pack_end(&history);
        header.pack_start(&tidy);
        let error = error_label();
        let spinner = adw::Spinner::builder().height_request(32).build();
        let top = adw::PreferencesGroup::new();
        top.add(&error);
        top.add(&spinner);
        let prefs = adw::PreferencesPage::new();
        prefs.add(&top);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        banners.add(&view);
        view.set_content(Some(&prefs));
        let page = adw::NavigationPage::builder()
            .title("Memory")
            .tag("memory")
            .child(&view)
            .build();

        let root = Rc::new(Root {
            store: store.clone(),
            prefs,
            error,
            spinner,
            tidy,
            groups: RefCell::default(),
            files: RefCell::default(),
            skills: RefCell::default(),
            asking: RefCell::default(),
        });
        let s = store.clone();
        history.connect_clicked(move |_| {
            let p = HistoryPage::new(&s, None);
            route::push(p.page.clone(), Box::new(p));
        });
        let weak = Rc::downgrade(&root);
        new_file.connect_clicked(move |b| {
            if let Some(r) = weak.upgrade() {
                r.ask_new_file(b);
            }
        });
        let weak = Rc::downgrade(&root);
        root.tidy.connect_clicked(move |_| {
            if let Some(r) = weak.upgrade() {
                r.ask(None);
            }
        });
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
                Change::Memory => r.load(),
                Change::Proposals => {
                    r.open_asked();
                    r.render();
                }
                _ => {}
            }
        });
        Memory {
            page,
            _inner: root,
            _listener: listener,
        }
    }
}

impl Root {
    fn load(self: &Rc<Self>) {
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let tree = store.memory_tree().await;
            let Some(r) = weak.upgrade() else { return };
            match tree {
                Ok(files) => {
                    r.error.set_visible(false);
                    r.files.replace(Some(files));
                }
                Err(e) => {
                    r.error.set_label(&e.message);
                    r.error.set_visible(true);
                }
            }
            r.spinner.set_visible(false);
            r.render();
            let _ = store.load_proposals().await;
            let skills = store.skills().await;
            if let Some(r) = weak.upgrade() {
                r.skills.replace(skills);
                r.render();
            }
        });
    }

    fn render(self: &Rc<Self>) {
        for g in self.groups.borrow_mut().drain(..) {
            self.prefs.remove(&g);
        }
        let asking = self.asking.borrow().as_ref().map(|a| a.skill.clone());
        self.tidy.set_sensitive(asking.is_none());
        self.tidy.set_label(if asking == Some(None) {
            "Tidying…"
        } else {
            "Tidy Up"
        });
        let mut groups = self.groups.borrow_mut();
        let st = self.store.state();
        let mut pending: Vec<_> = st
            .proposals
            .values()
            .filter(|p| p.status == ProposalStatus::Pending)
            .collect();
        pending.sort_by_key(|p| p.id);
        if !pending.is_empty() {
            let group = adw::PreferencesGroup::builder()
                .title("To look over")
                .build();
            for p in &pending {
                let row = adw::ActionRow::builder()
                    .title(&p.title)
                    .use_markup(false)
                    .activatable(true)
                    .build();
                let (store, id) = (self.store.clone(), p.id);
                row.connect_activated(move |_| open_proposal(&store, id));
                group.add(&row);
            }
            groups.push(group);
        }

        let wrong: Vec<_> = self
            .skills
            .borrow()
            .iter()
            .filter(|s| !s.failed.is_empty() || !s.takeovers.is_empty())
            .filter(|s| !pending.iter().any(|p| p.skill.as_ref() == Some(&s.name)))
            .cloned()
            .collect();
        if !wrong.is_empty() {
            let group = adw::PreferencesGroup::builder()
                .title("Skills that went wrong")
                .build();
            for s in &wrong {
                let mut what = vec![];
                if !s.failed.is_empty() {
                    what.push(format!("{} of {} failed", s.failed.len(), s.runs));
                }
                if !s.takeovers.is_empty() {
                    what.push(format!("{} needed you", s.takeovers.len()));
                }
                let row = adw::ActionRow::builder()
                    .title(&s.name)
                    .subtitle(what.join(", "))
                    .use_markup(false)
                    .build();
                let looking = asking.as_ref() == Some(&Some(s.name.clone()));
                let fix = gtk::Button::builder()
                    .label(if looking {
                        "Looking…"
                    } else {
                        "Suggest a Fix"
                    })
                    .valign(gtk::Align::Center)
                    .sensitive(asking.is_none())
                    .build();
                let (weak, name) = (Rc::downgrade(self), s.name.clone());
                fix.connect_clicked(move |_| {
                    if let Some(r) = weak.upgrade() {
                        r.ask(Some(name.clone()));
                    }
                });
                row.add_suffix(&fix);
                group.add(&row);
            }
            groups.push(group);
        }

        if let Some(files) = self.files.borrow().as_ref() {
            for (folder, list) in memory::groups(files) {
                let group = adw::PreferencesGroup::new();
                if !folder.is_empty() {
                    group.set_title(&glib::markup_escape_text(&format!("{folder}/")));
                }
                for f in list {
                    let row = adw::ActionRow::builder()
                        .title(memory::name(&f.path))
                        .use_markup(false)
                        .activatable(true)
                        .build();
                    row.add_prefix(&Icon::new("file", 16));
                    let (store, path) = (self.store.clone(), f.path.clone());
                    row.connect_activated(move |_| open_file(&store, &path, false));
                    group.add(&row);
                }
                groups.push(group);
            }
        }
        for g in groups.iter() {
            self.prefs.add(g);
        }
    }

    fn ask_new_file(self: &Rc<Self>, from: &gtk::Button) {
        let entry = gtk::Entry::builder()
            .placeholder_text("projects/garden.md")
            .activates_default(true)
            .build();
        let dialog = adw::AlertDialog::new(Some("New File"), None);
        dialog.set_extra_child(Some(&entry));
        dialog.add_responses(&[("cancel", "Cancel"), ("create", "Create")]);
        dialog.set_response_appearance("create", adw::ResponseAppearance::Suggested);
        dialog.set_default_response(Some("create"));
        dialog.set_close_response("cancel");
        let weak = Rc::downgrade(self);
        dialog.connect_response(Some("create"), move |_, _| {
            let (Some(r), Some(path)) = (weak.upgrade(), memory::new_path(&entry.text())) else {
                return;
            };
            let exists = r
                .files
                .borrow()
                .as_ref()
                .is_some_and(|f| f.iter().any(|f| f.path == path));
            open_file(&r.store, &path, !exists);
        });
        dialog.present(Some(from));
    }

    fn ask(self: &Rc<Self>, skill: Option<String>) {
        if self.asking.borrow().is_some() {
            return;
        }
        let before = self.store.state().proposals.keys().copied().collect();
        self.asking.replace(Some(Asking {
            skill: skill.clone(),
            before,
        }));
        self.render();
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.ask_proposal(skill.as_deref()).await;
            let Some(r) = weak.upgrade() else { return };
            match result {
                // It comes as an event; failures come through ntfy.
                Ok(Asked::Started) => {
                    glib::timeout_future(ASK_WAIT).await;
                    if let Some(r) = weak.upgrade() {
                        r.asking.replace(None);
                        r.render();
                    }
                    return;
                }
                Ok(Asked::Proposal(p)) => open_proposal(&store, p.id),
                Ok(Asked::Nothing) => store.toast(if skill.is_some() {
                    "No fix found"
                } else {
                    "Nothing to tidy"
                }),
                Err(e) => {
                    r.error.set_label(&e.message);
                    r.error.set_visible(true);
                }
            }
            r.asking.replace(None);
            r.render();
        });
    }

    /// The proposal asked for, once it comes.
    fn open_asked(&self) {
        let id = {
            let asking = self.asking.borrow();
            let Some(a) = asking.as_ref() else { return };
            let st = self.store.state();
            let mut new: Vec<_> = st
                .proposals
                .values()
                .filter(|p| p.status == ProposalStatus::Pending && !a.before.contains(&p.id))
                .filter(|p| match &a.skill {
                    Some(name) => p.skill.as_ref() == Some(name),
                    None => p.kind == ProposalKind::Tidy,
                })
                .map(|p| p.id)
                .collect();
            new.sort();
            new.first().copied()
        };
        if let Some(id) = id {
            self.asking.replace(None);
            open_proposal(&self.store, id);
        }
    }
}

fn open_file(store: &Store, path: &str, is_new: bool) {
    let p = FilePage::new(store, path, is_new);
    route::push(p.page.clone(), Box::new(p));
}

fn open_proposal(store: &Store, id: i64) {
    let p = ProposalPage::new(store, id);
    route::push(p.page.clone(), Box::new(p));
}

/// A memory file: read, edit, history, delete.
pub struct FilePage {
    pub page: adw::NavigationPage,
    _inner: Rc<File>,
    _listener: Listener,
}

struct File {
    store: Store,
    path: String,
    page: adw::NavigationPage,
    header: adw::HeaderBar,
    stack: gtk::Stack,
    missing: adw::StatusPage,
    error: gtk::Label,
    markdown: Markdown,
    editor: gtk::TextView,
    edit: gtk::Button,
    menu: gtk::MenuButton,
    cancel: gtk::Button,
    save: gtk::Button,
    conflict_bar: gtk::Box,
    conflict_heading: gtk::Label,
    conflict_copy: gtk::Label,
    conflict_buttons: Vec<gtk::Button>,
    /// What's saved, once read; None for a new file not yet saved.
    content: RefCell<Option<String>>,
    base: RefCell<String>,
    conflict: RefCell<Option<MemoryConflict>>,
    editing: Cell<bool>,
    is_new: Cell<bool>,
    saving: Cell<bool>,
}

impl FilePage {
    pub fn new(store: &Store, path: &str, is_new: bool) -> FilePage {
        let edit = gtk::Button::builder().label("Edit").build();
        let menu_model = gio::Menu::new();
        menu_model.append(Some("History"), Some("file.history"));
        if memory::name(path) != "INDEX.md" {
            menu_model.append(Some("Delete"), Some("file.delete"));
        }
        let menu = gtk::MenuButton::builder()
            .icon_name("view-more-symbolic")
            .tooltip_text("More")
            .menu_model(&menu_model)
            .build();
        let cancel = gtk::Button::builder()
            .label("Cancel")
            .visible(false)
            .build();
        let save = gtk::Button::builder()
            .label("Save")
            .visible(false)
            .css_classes(["suggested-action"])
            .build();
        let header = adw::HeaderBar::new();
        header.pack_end(&menu);
        header.pack_end(&edit);
        header.pack_end(&save);
        header.pack_start(&cancel);

        let error = error_label();
        error.set_margin_start(12);
        error.set_margin_end(12);
        error.set_margin_top(6);
        let markdown = Markdown::new("");
        let read = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vexpand(true)
            .child(
                &adw::Clamp::builder()
                    .maximum_size(720)
                    .margin_top(12)
                    .margin_bottom(24)
                    .margin_start(12)
                    .margin_end(12)
                    .child(&markdown.root)
                    .build(),
            )
            .build();

        let conflict_heading = gtk::Label::builder()
            .xalign(0.0)
            .wrap(true)
            .css_classes(["heading"])
            .build();
        let conflict_copy = gtk::Label::builder()
            .xalign(0.0)
            .yalign(0.0)
            .wrap(true)
            .selectable(true)
            .css_classes(["monospace", "caption"])
            .build();
        let saved_copy = gtk::Expander::builder()
            .label("The saved copy")
            .child(
                &gtk::ScrolledWindow::builder()
                    .hscrollbar_policy(gtk::PolicyType::Never)
                    .max_content_height(200)
                    .propagate_natural_height(true)
                    .child(&conflict_copy)
                    .build(),
            )
            .build();
        let reload = gtk::Button::with_label("Reload");
        let overwrite = gtk::Button::with_label("Overwrite");
        let buttons = gtk::Box::builder().spacing(8).build();
        buttons.append(&reload);
        buttons.append(&overwrite);
        let conflict_bar = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(8)
            .visible(false)
            .css_classes(["card", "task-head"])
            .margin_top(12)
            .margin_start(12)
            .margin_end(12)
            .build();
        conflict_bar.append(&conflict_heading);
        conflict_bar.append(&saved_copy);
        conflict_bar.append(&buttons);
        let editor = gtk::TextView::builder()
            .monospace(true)
            .wrap_mode(gtk::WrapMode::WordChar)
            .top_margin(12)
            .bottom_margin(12)
            .left_margin(12)
            .right_margin(12)
            .build();
        let edit_view = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .build();
        edit_view.append(&conflict_bar);
        edit_view.append(
            &gtk::ScrolledWindow::builder()
                .vexpand(true)
                .child(&editor)
                .build(),
        );

        let missing = adw::StatusPage::builder()
            .icon_name("dialog-question-symbolic")
            .build();
        let stack = gtk::Stack::new();
        stack.add_named(&adw::Spinner::new(), Some("loading"));
        stack.add_named(&missing, Some("missing"));
        stack.add_named(&read, Some("read"));
        stack.add_named(&edit_view, Some("edit"));
        let content = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .build();
        content.append(&error);
        content.append(&stack);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        view.set_content(Some(&content));
        let page = adw::NavigationPage::builder()
            .title(memory::name(path))
            .child(&view)
            .build();

        let f = Rc::new(File {
            store: store.clone(),
            path: path.into(),
            page: page.clone(),
            header,
            stack,
            missing,
            error,
            markdown,
            editor,
            edit,
            menu,
            cancel,
            save,
            conflict_bar,
            conflict_heading,
            conflict_copy,
            conflict_buttons: vec![reload.clone(), overwrite.clone()],
            content: RefCell::default(),
            base: RefCell::default(),
            conflict: RefCell::default(),
            editing: Cell::new(false),
            is_new: Cell::new(is_new),
            saving: Cell::new(false),
        });
        f.connect(&reload, &overwrite);
        if is_new {
            f.start_editing(&memory::new_file(path));
        } else {
            f.load();
        }
        let weak = Rc::downgrade(&f);
        let listener = store.listen(move |change| {
            if let (Some(f), Change::Memory) = (weak.upgrade(), change)
                && !f.editing.get()
                && !f.is_new.get()
            {
                f.load();
            }
        });
        FilePage {
            page,
            _inner: f,
            _listener: listener,
        }
    }
}

impl File {
    fn connect(self: &Rc<Self>, reload: &gtk::Button, overwrite: &gtk::Button) {
        let actions = gio::SimpleActionGroup::new();
        let history = gio::SimpleAction::new("history", None);
        let weak = Rc::downgrade(self);
        history.connect_activate(move |_, _| {
            if let Some(f) = weak.upgrade() {
                let p = HistoryPage::new(&f.store, Some(&f.path));
                route::push(p.page.clone(), Box::new(p));
            }
        });
        actions.add_action(&history);
        let delete = gio::SimpleAction::new("delete", None);
        let weak = Rc::downgrade(self);
        delete.connect_activate(move |_, _| {
            let Some(f) = weak.upgrade() else { return };
            let weak = Rc::downgrade(&f);
            confirm(
                &f.page,
                &format!("Delete {}? It stays in the history.", memory::name(&f.path)),
                "Delete",
                move || {
                    if let Some(f) = weak.upgrade() {
                        f.delete();
                    }
                },
            );
        });
        actions.add_action(&delete);
        self.page.insert_action_group("file", Some(&actions));

        let weak = Rc::downgrade(self);
        self.edit.connect_clicked(move |_| {
            if let Some(f) = weak.upgrade() {
                let text = f.content.borrow().clone().unwrap_or_default();
                f.start_editing(&text);
            }
        });
        let weak = Rc::downgrade(self);
        self.cancel.connect_clicked(move |_| {
            let Some(f) = weak.upgrade() else { return };
            f.conflict.replace(None);
            if f.content.borrow().is_none() {
                let _ = f.page.activate_action("navigation.pop", None);
            } else {
                f.stop_editing();
            }
        });
        let weak = Rc::downgrade(self);
        self.save.connect_clicked(move |_| {
            if let Some(f) = weak.upgrade() {
                f.save_over(None);
            }
        });
        let weak = Rc::downgrade(self);
        self.editor.buffer().connect_changed(move |_| {
            if let Some(f) = weak.upgrade() {
                f.sync();
            }
        });
        let weak = Rc::downgrade(self);
        reload.connect_clicked(move |_| {
            let Some(f) = weak.upgrade() else { return };
            let Some(c) = f.conflict.take() else { return };
            f.content.replace(Some(c.content.clone()));
            f.base.replace(c.sha);
            f.editor.buffer().set_text(&c.content);
            f.sync();
        });
        let weak = Rc::downgrade(self);
        overwrite.connect_clicked(move |_| {
            let Some(f) = weak.upgrade() else { return };
            let over = f.conflict.borrow().as_ref().map(|c| c.sha.clone());
            f.save_over(over);
        });
    }

    fn load(self: &Rc<Self>) {
        let (weak, store, path) = (Rc::downgrade(self), self.store.clone(), self.path.clone());
        glib::spawn_future_local(async move {
            let result = store.memory_file(&path).await;
            let Some(f) = weak.upgrade() else { return };
            match result {
                Ok(c) => {
                    f.error.set_visible(false);
                    f.markdown.set(&c.content);
                    f.content.replace(Some(c.content));
                    f.base.replace(c.sha);
                    if !f.editing.get() {
                        f.stack.set_visible_child_name("read");
                    }
                }
                Err(e) if f.content.borrow().is_none() => {
                    f.missing.set_title(&e.message);
                    f.stack.set_visible_child_name("missing");
                    f.edit.set_visible(false);
                }
                Err(e) => f.show_error(&e.message),
            }
        });
    }

    fn show_error(&self, text: &str) {
        self.error.set_label(text);
        self.error.set_visible(true);
    }

    fn draft(&self) -> String {
        let b = self.editor.buffer();
        b.text(&b.start_iter(), &b.end_iter(), false).to_string()
    }

    fn start_editing(&self, text: &str) {
        self.editing.set(true);
        self.editor.buffer().set_text(text);
        self.stack.set_visible_child_name("edit");
        self.page.set_can_pop(false);
        self.header.set_show_back_button(false);
        self.edit.set_visible(false);
        self.menu.set_visible(false);
        self.cancel.set_visible(true);
        self.save.set_visible(true);
        self.editor.grab_focus();
        self.sync();
    }

    fn stop_editing(&self) {
        self.editing.set(false);
        self.stack.set_visible_child_name("read");
        self.page.set_can_pop(true);
        self.header.set_show_back_button(true);
        self.edit.set_visible(true);
        self.menu.set_visible(true);
        self.cancel.set_visible(false);
        self.save.set_visible(false);
        // Not the text, which would come up selected.
        self.edit.grab_focus();
        self.sync();
    }

    fn sync(&self) {
        let conflict = self.conflict.borrow();
        let changed = self.content.borrow().as_deref() != Some(self.draft().as_str());
        self.save
            .set_sensitive(!self.saving.get() && changed && conflict.is_none());
        self.conflict_bar.set_visible(conflict.is_some());
        if let Some(c) = conflict.as_ref() {
            self.conflict_heading
                .set_label(if self.content.borrow().is_none() {
                    "There's already a file here."
                } else {
                    "Changed while you were editing."
                });
            self.conflict_copy.set_label(&c.content);
        }
        for b in &self.conflict_buttons {
            b.set_sensitive(!self.saving.get());
        }
    }

    /// Saves the draft over the version it was based on, or over `over` to keep yours.
    fn save_over(self: &Rc<Self>, over: Option<String>) {
        if self.saving.replace(true) {
            return;
        }
        self.sync();
        let draft = self.draft();
        let base = over.unwrap_or_else(|| self.base.borrow().clone());
        let (weak, store, path) = (Rc::downgrade(self), self.store.clone(), self.path.clone());
        glib::spawn_future_local(async move {
            let result = store.save_memory(&path, &draft, &base).await;
            let Some(f) = weak.upgrade() else { return };
            f.saving.set(false);
            match result {
                Ok(sha) => {
                    f.error.set_visible(false);
                    f.conflict.replace(None);
                    f.is_new.set(false);
                    f.markdown.set(&draft);
                    f.content.replace(Some(draft));
                    f.stop_editing();
                    store.toast(&match sha {
                        Some(sha) => format!("Saved ({})", &sha[..sha.len().min(7)]),
                        None => "No changes".into(),
                    });
                    // For the sha the next save is based on.
                    f.load();
                }
                Err(e) => match conflict(&e) {
                    Some(c) => {
                        f.conflict.replace(Some(c));
                        f.sync();
                    }
                    None => {
                        f.show_error(&e.message);
                        store.toast(&e.message);
                        f.sync();
                    }
                },
            }
        });
    }

    fn delete(self: &Rc<Self>) {
        let (weak, store, path) = (Rc::downgrade(self), self.store.clone(), self.path.clone());
        glib::spawn_future_local(async move {
            let result = store.delete_memory(&path).await;
            let Some(f) = weak.upgrade() else { return };
            match result {
                Ok(()) => {
                    store.toast(&format!("Deleted {path}"));
                    let _ = f.page.activate_action("navigation.pop", None);
                }
                Err(e) => f.show_error(&e.message),
            }
        });
    }
}

/// The changes to one file, or to all of memory.
pub struct HistoryPage {
    pub page: adw::NavigationPage,
    _inner: Rc<History>,
    _listener: Listener,
}

struct History {
    store: Store,
    path: Option<String>,
    error: gtk::Label,
    list: adw::PreferencesGroup,
    rows: RefCell<Vec<gtk::Widget>>,
}

impl HistoryPage {
    pub fn new(store: &Store, path: Option<&str>) -> HistoryPage {
        let error = error_label();
        let list = adw::PreferencesGroup::new();
        list.add(&error);
        let prefs = adw::PreferencesPage::new();
        prefs.add(&list);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&adw::HeaderBar::new());
        view.set_content(Some(&prefs));
        let page = adw::NavigationPage::builder()
            .title(path.map_or("History", memory::name))
            .child(&view)
            .build();
        let h = Rc::new(History {
            store: store.clone(),
            path: path.map(String::from),
            error,
            list,
            rows: RefCell::default(),
        });
        h.load();
        let weak = Rc::downgrade(&h);
        let listener = store.listen(move |change| {
            if let (Some(h), Change::Memory) = (weak.upgrade(), change) {
                h.load();
            }
        });
        HistoryPage {
            page,
            _inner: h,
            _listener: listener,
        }
    }
}

impl History {
    fn load(self: &Rc<Self>) {
        let (weak, store, path) = (Rc::downgrade(self), self.store.clone(), self.path.clone());
        glib::spawn_future_local(async move {
            let result = store.memory_log(path.as_deref()).await;
            let Some(h) = weak.upgrade() else { return };
            match result {
                Ok(log) => {
                    h.error.set_visible(false);
                    h.show(&log);
                }
                Err(e) => {
                    h.error.set_label(&e.message);
                    h.error.set_visible(true);
                }
            }
        });
    }

    fn show(&self, log: &[MemoryCommit]) {
        for r in self.rows.borrow_mut().drain(..) {
            self.list.remove(&r);
        }
        let mut rows = self.rows.borrow_mut();
        if log.is_empty() {
            let l = note("No changes yet.");
            self.list.add(&l);
            rows.push(l.upcast());
        }
        for c in log {
            let row = adw::ActionRow::builder()
                .title(&c.message)
                .title_lines(2)
                .subtitle(format!("{} · {}", c.author, format::stamp(&c.date)))
                .use_markup(false)
                .activatable(true)
                .build();
            let (store, c) = (self.store.clone(), c.clone());
            row.connect_activated(move |_| {
                let p = CommitPage::new(&store, &c);
                route::push(p.page.clone(), Box::new(p));
            });
            self.list.add(&row);
            rows.push(row.upcast());
        }
    }
}

/// A commit's diff, with Revert.
pub struct CommitPage {
    pub page: adw::NavigationPage,
    _inner: Rc<Commit>,
}

struct Commit {
    store: Store,
    commit: MemoryCommit,
    error: gtk::Label,
}

impl CommitPage {
    pub fn new(store: &Store, commit: &MemoryCommit) -> CommitPage {
        let revert = gtk::Button::builder()
            .icon_name("edit-undo-symbolic")
            .tooltip_text("Revert")
            .build();
        let header = adw::HeaderBar::new();
        header.pack_end(&revert);
        let error = error_label();
        let diff = adw::Bin::builder()
            .child(&adw::Spinner::builder().height_request(32).build())
            .build();
        let column = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(8)
            .margin_top(12)
            .margin_bottom(24)
            .margin_start(12)
            .margin_end(12)
            .build();
        column.append(
            &gtk::Label::builder()
                .label(&commit.message)
                .xalign(0.0)
                .wrap(true)
                .css_classes(["heading"])
                .build(),
        );
        let mut meta = vec![commit.author.clone()];
        if !commit.files.is_empty() {
            meta.push(commit.files.join(", "));
        }
        meta.push(format::stamp(&commit.date));
        column.append(
            &gtk::Label::builder()
                .label(meta.join(" · "))
                .xalign(0.0)
                .wrap(true)
                .css_classes(["caption", "dim-label"])
                .build(),
        );
        column.append(&error);
        column.append(&diff);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        view.set_content(Some(
            &gtk::ScrolledWindow::builder()
                .hscrollbar_policy(gtk::PolicyType::Never)
                .child(
                    &adw::Clamp::builder()
                        .maximum_size(900)
                        .child(&column)
                        .build(),
                )
                .build(),
        ));
        let page = adw::NavigationPage::builder()
            .title(&commit.sha[..commit.sha.len().min(7)])
            .child(&view)
            .build();
        let c = Rc::new(Commit {
            store: store.clone(),
            commit: commit.clone(),
            error,
        });
        let weak = Rc::downgrade(&c);
        revert.connect_clicked(move |b| {
            let Some(c) = weak.upgrade() else { return };
            let weak = Rc::downgrade(&c);
            confirm(
                b,
                &format!("Revert “{}”?", c.commit.message),
                "Revert",
                move || {
                    if let Some(c) = weak.upgrade() {
                        c.revert();
                    }
                },
            );
        });
        let (weak, s, sha) = (Rc::downgrade(&c), store.clone(), commit.sha.clone());
        glib::spawn_future_local(async move {
            let result = s.memory_diff(&sha).await;
            let Some(c) = weak.upgrade() else { return };
            match result {
                Ok(d) => diff.set_child(Some(&diff_view(&memory::parse_diff(&d)))),
                Err(e) => {
                    diff.set_child(None::<&gtk::Widget>);
                    c.show_error(&e.message);
                }
            }
        });
        CommitPage { page, _inner: c }
    }
}

impl Commit {
    fn show_error(&self, text: &str) {
        self.error.set_label(text);
        self.error.set_visible(true);
    }

    fn revert(self: &Rc<Self>) {
        let (weak, store, sha) = (
            Rc::downgrade(self),
            self.store.clone(),
            self.commit.sha.clone(),
        );
        glib::spawn_future_local(async move {
            let result = store.revert_memory(&sha).await;
            let Some(c) = weak.upgrade() else { return };
            match result {
                Ok(Some(sha)) => {
                    c.error.set_visible(false);
                    store.toast(&format!(
                        "Reverted. New commit {}",
                        &sha[..sha.len().min(7)]
                    ));
                }
                Ok(None) => store.toast("Nothing to revert"),
                Err(e) => c.show_error(&e.message),
            }
        });
    }
}

/// A proposal's changes, to apply or dismiss.
pub struct ProposalPage {
    pub page: adw::NavigationPage,
    _inner: Rc<ProposalView>,
    _listener: Listener,
}

struct ProposalView {
    store: Store,
    id: i64,
    page: adw::NavigationPage,
    title: gtk::Label,
    reason: gtk::Label,
    error: gtk::Label,
    changes: gtk::Box,
    shown: Cell<bool>,
    bar: gtk::Box,
    buttons: Vec<gtk::Button>,
    busy: Cell<bool>,
}

impl ProposalPage {
    pub fn new(store: &Store, id: i64) -> ProposalPage {
        let title = gtk::Label::builder()
            .xalign(0.0)
            .wrap(true)
            .css_classes(["title-3"])
            .build();
        let reason = gtk::Label::builder().xalign(0.0).wrap(true).build();
        let error = error_label();
        let changes = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(8)
            .build();
        let column = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(10)
            .margin_top(12)
            .margin_bottom(24)
            .margin_start(12)
            .margin_end(12)
            .build();
        column.append(&title);
        column.append(&reason);
        column.append(&error);
        column.append(&changes);
        let dismiss = gtk::Button::builder()
            .label("Dismiss")
            .css_classes(["destructive-action"])
            .build();
        let apply = gtk::Button::builder()
            .label("Apply")
            .css_classes(["suggested-action"])
            .build();
        let bar = gtk::Box::builder()
            .spacing(8)
            .halign(gtk::Align::End)
            .margin_top(8)
            .margin_bottom(8)
            .margin_start(12)
            .margin_end(12)
            .visible(false)
            .build();
        bar.append(&dismiss);
        bar.append(&apply);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&adw::HeaderBar::new());
        view.add_bottom_bar(&bar);
        view.set_content(Some(
            &gtk::ScrolledWindow::builder()
                .hscrollbar_policy(gtk::PolicyType::Never)
                .child(
                    &adw::Clamp::builder()
                        .maximum_size(900)
                        .child(&column)
                        .build(),
                )
                .build(),
        ));
        let page = adw::NavigationPage::builder()
            .title("Tidy-up")
            .child(&view)
            .build();
        let p = Rc::new(ProposalView {
            store: store.clone(),
            id,
            page: page.clone(),
            title,
            reason,
            error,
            changes,
            shown: Cell::new(false),
            bar,
            buttons: vec![dismiss.clone(), apply.clone()],
            busy: Cell::new(false),
        });
        for (button, apply) in [(&dismiss, false), (&apply, true)] {
            let weak = Rc::downgrade(&p);
            button.connect_clicked(move |_| {
                if let Some(p) = weak.upgrade() {
                    p.resolve(apply);
                }
            });
        }
        p.render();
        let weak = Rc::downgrade(&p);
        let listener = store.listen(move |change| {
            if let (Some(p), Change::Proposals) = (weak.upgrade(), change) {
                p.render();
            }
        });
        ProposalPage {
            page,
            _inner: p,
            _listener: listener,
        }
    }
}

impl ProposalView {
    fn render(self: &Rc<Self>) {
        let Some(p) = self.store.state().proposals.get(&self.id).cloned() else {
            return;
        };
        self.bar.set_visible(p.status == ProposalStatus::Pending);
        if self.shown.replace(true) {
            return;
        }
        self.page.set_title(match p.kind {
            ProposalKind::Skill => "Skill fix",
            ProposalKind::Write => "Memory change",
            ProposalKind::Tidy => "Tidy-up",
        });
        self.title.set_label(&p.title);
        self.reason.set_label(&p.reason);
        for c in p.changes {
            let what = match (&c.before, &c.after) {
                (None, _) => format!("{} (new)", c.path),
                (_, None) => format!("{} (deleted)", c.path),
                _ => c.path.clone(),
            };
            self.changes.append(
                &gtk::Label::builder()
                    .label(&what)
                    .xalign(0.0)
                    .margin_top(8)
                    .css_classes(["heading"])
                    .build(),
            );
            let slot = adw::Bin::builder()
                .child(&adw::Spinner::builder().height_request(32).build())
                .build();
            self.changes.append(&slot);
            // A big file's diff takes a moment.
            glib::spawn_future_local(async move {
                let lines = gio::spawn_blocking(move || {
                    memory::line_diff(c.before.as_deref(), c.after.as_deref())
                })
                .await
                .unwrap_or_default();
                slot.set_child(Some(&diff_view(&lines)));
            });
        }
    }

    fn resolve(self: &Rc<Self>, apply: bool) {
        if self.busy.replace(true) {
            return;
        }
        for b in &self.buttons {
            b.set_sensitive(false);
        }
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.resolve_proposal(id, apply).await;
            let Some(p) = weak.upgrade() else { return };
            p.busy.set(false);
            for b in &p.buttons {
                b.set_sensitive(true);
            }
            match result {
                Ok(()) => {
                    if apply {
                        store.toast("Applied");
                    }
                    let _ = p.page.activate_action("navigation.pop", None);
                }
                Err(e) => {
                    p.error.set_label(&e.message);
                    p.error.set_visible(true);
                }
            }
        });
    }
}

/// Diff lines in a fixed-width face, added ones green and removed ones red, scrolling sideways.
pub fn diff_view(lines: &[DiffLine]) -> gtk::Widget {
    let buffer = gtk::TextBuffer::new(None);
    let tags = buffer.tag_table();
    let tag = |name: &str, background: Option<gdk::RGBA>, dim: bool| {
        let t = gtk::TextTag::new(Some(name));
        if let Some(bg) = background {
            t.set_paragraph_background_rgba(Some(&bg));
        }
        if dim {
            t.set_foreground_rgba(Some(&gdk::RGBA::new(0.5, 0.5, 0.5, 1.0)));
        }
        tags.add(&t);
        t
    };
    let added = tag("added", Some(gdk::RGBA::new(0.2, 0.78, 0.35, 0.15)), false);
    let removed = tag(
        "removed",
        Some(gdk::RGBA::new(1.0, 0.23, 0.19, 0.15)),
        false,
    );
    let hunk = tag("hunk", None, true);
    for (i, l) in lines.iter().enumerate() {
        let mut end = buffer.end_iter();
        let text = if l.text.is_empty() { " " } else { &l.text };
        let text = if i + 1 < lines.len() {
            format!("{text}\n")
        } else {
            text.to_string()
        };
        match l.kind {
            DiffKind::Added => buffer.insert_with_tags(&mut end, &text, &[&added]),
            DiffKind::Removed => buffer.insert_with_tags(&mut end, &text, &[&removed]),
            DiffKind::Hunk => buffer.insert_with_tags(&mut end, &text, &[&hunk]),
            DiffKind::Context => buffer.insert(&mut end, &text),
        }
    }
    let view = gtk::TextView::builder()
        .buffer(&buffer)
        .editable(false)
        .cursor_visible(false)
        .monospace(true)
        .top_margin(8)
        .bottom_margin(8)
        .left_margin(8)
        .right_margin(8)
        .css_classes(["card", "text-area", "diff"])
        .build();
    gtk::ScrolledWindow::builder()
        .vscrollbar_policy(gtk::PolicyType::Never)
        .propagate_natural_height(true)
        .child(&view)
        .build()
        .upcast()
}
