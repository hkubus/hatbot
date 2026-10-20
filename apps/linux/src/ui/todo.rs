// The to-do list (PLAN.md §24.2 L6, TodoView on iOS): todo.md's open items, ticked off here or worked
// on by a task, and what was done this week. Items are changed in the chat or in Memory.
use std::cell::RefCell;
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use hatbot::core::links::Link;
use hatbot::core::models::{Todo, TodoList};
use hatbot::core::todo;
use hatbot::store::{Change, Listener, Store};

use super::form::{error_label, note};
use super::icon::Icon;
use super::route;
use super::shell::Banners;

pub struct Todos {
    pub page: adw::NavigationPage,
    _inner: Rc<Inner>,
    _listener: Listener,
}

struct Inner {
    store: Store,
    prefs: adw::PreferencesPage,
    error: gtk::Label,
    spinner: adw::Spinner,
    groups: RefCell<Vec<adw::PreferencesGroup>>,
    /// The tasks on to-dos, to load again when one starts or ends.
    on_todos: RefCell<Vec<i64>>,
}

impl Todos {
    pub fn new(store: &Store, banners: &Banners) -> Todos {
        let add = gtk::Button::builder()
            .icon_name("list-add-symbolic")
            .tooltip_text("New To-do")
            .build();
        let header = adw::HeaderBar::new();
        header.pack_end(&add);
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
            .title("To-do")
            .tag("todo")
            .child(&view)
            .build();
        let inner = Rc::new(Inner {
            store: store.clone(),
            prefs,
            error,
            spinner,
            groups: RefCell::default(),
            on_todos: RefCell::default(),
        });
        let weak = Rc::downgrade(&inner);
        add.connect_clicked(move |b| {
            if let Some(i) = weak.upgrade() {
                i.ask_new(b);
            }
        });
        let weak = Rc::downgrade(&inner);
        page.connect_showing(move |_| {
            if let Some(i) = weak.upgrade() {
                i.load();
            }
        });
        let weak = Rc::downgrade(&inner);
        let listener = store.listen(move |change| {
            let Some(i) = weak.upgrade() else { return };
            match change {
                Change::Memory => i.load(),
                Change::Task(_) | Change::Tasks => {
                    let now = i.on_todos();
                    if *i.on_todos.borrow() != now {
                        i.on_todos.replace(now);
                        i.load();
                    }
                }
                _ => {}
            }
        });
        inner.on_todos.replace(inner.on_todos());
        Todos {
            page,
            _inner: inner,
            _listener: listener,
        }
    }
}

impl Inner {
    fn on_todos(&self) -> Vec<i64> {
        let st = self.store.state();
        let mut ids: Vec<i64> = st
            .tasks
            .values()
            .filter(|t| t.todo.is_some() && t.finished_at.is_none())
            .map(|t| t.id)
            .collect();
        ids.sort();
        ids
    }

    fn load(self: &Rc<Self>) {
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.todos().await;
            if let Some(i) = weak.upgrade() {
                i.got(result);
            }
        });
    }

    fn got(self: &Rc<Self>, result: hatbot::net::api::Result<TodoList>) {
        self.spinner.set_visible(false);
        match result {
            Ok(list) => {
                self.error.set_visible(false);
                self.show(&list.items);
            }
            Err(e) => {
                self.error.set_label(&e.message);
                self.error.set_visible(true);
            }
        }
    }

    fn show(self: &Rc<Self>, items: &[Todo]) {
        for g in self.groups.borrow_mut().drain(..) {
            self.prefs.remove(&g);
        }
        let today = glib::DateTime::now_local()
            .and_then(|d| d.format("%Y-%m-%d"))
            .map(|s| s.to_string())
            .unwrap_or_default();
        let (open, done) = todo::split(items);
        let first = adw::PreferencesGroup::new();
        if open.is_empty() {
            first.add(&note(
                "Nothing to do. Add one here, or ask Hatbot in the chat.",
            ));
        }
        for t in open {
            first.add(&self.open_row(t, &today));
        }
        let mut groups = vec![first];
        if !done.is_empty() {
            let g = adw::PreferencesGroup::builder()
                .title("Done this week")
                .build();
            for t in done {
                let row = adw::ActionRow::builder()
                    .title(&t.text)
                    .use_markup(false)
                    .css_classes(["dim-label"])
                    .build();
                row.add_prefix(
                    &gtk::CheckButton::builder()
                        .active(true)
                        .sensitive(false)
                        .valign(gtk::Align::Center)
                        .build(),
                );
                if let Some(on) = &t.done_on {
                    row.add_suffix(&gtk::Label::new(Some(&todo::day(on))));
                }
                g.add(&row);
            }
            groups.push(g);
        }
        for g in &groups {
            self.prefs.add(g);
        }
        self.groups.replace(groups);
    }

    fn open_row(self: &Rc<Self>, t: &Todo, today: &str) -> adw::ActionRow {
        let row = adw::ActionRow::builder()
            .title(&t.text)
            .use_markup(false)
            .build();
        let tick = gtk::CheckButton::builder()
            .valign(gtk::Align::Center)
            .tooltip_text("Done")
            .build();
        row.add_prefix(&tick);
        row.set_activatable_widget(Some(&tick));
        let (weak, item) = (Rc::downgrade(self), t.clone());
        tick.connect_toggled(move |tick| {
            let Some(i) = weak.upgrade() else { return };
            tick.set_sensitive(false);
            let (weak, store, item) = (Rc::downgrade(&i), i.store.clone(), item.clone());
            glib::spawn_future_local(async move {
                let result = store.tick_todo(&item).await;
                if let Some(i) = weak.upgrade() {
                    i.got(result);
                }
            });
        });
        if let Some(task) = t.task_id {
            let working = gtk::Button::builder()
                .label("Working on it")
                .valign(gtk::Align::Center)
                .css_classes(["flat"])
                .build();
            working.connect_clicked(move |_| route::go(Link::Task(task)));
            row.add_suffix(&working);
            return row;
        }
        if let Some((text, overdue)) = todo::due(t, today) {
            let label = gtk::Label::new(Some(&text));
            label.add_css_class(if overdue { "error" } else { "dim-label" });
            row.add_suffix(&label);
        }
        let work = gtk::Button::builder()
            .child(&Icon::new("play", 16))
            .tooltip_text("Work on It")
            .valign(gtk::Align::Center)
            .css_classes(["flat"])
            .build();
        let (weak, item) = (Rc::downgrade(self), t.clone());
        work.connect_clicked(move |b| {
            let Some(i) = weak.upgrade() else { return };
            b.set_sensitive(false);
            let (weak, store, item, b) =
                (Rc::downgrade(&i), i.store.clone(), item.clone(), b.clone());
            glib::spawn_future_local(async move {
                let result = store.work_on_todo(&item).await;
                let Some(i) = weak.upgrade() else { return };
                match result {
                    Ok(_) => {
                        store.toast("Hatbot is on it");
                        i.load();
                    }
                    Err(e) => {
                        b.set_sensitive(true);
                        store.toast(&e.message);
                    }
                }
            });
        });
        row.add_suffix(&work);
        row
    }

    fn ask_new(self: &Rc<Self>, from: &gtk::Button) {
        let entry = gtk::Entry::builder()
            .placeholder_text("What's to do")
            .activates_default(true)
            .build();
        let due = gtk::CheckButton::with_label("Due");
        let calendar = gtk::Calendar::new();
        let day = gtk::MenuButton::builder()
            .popover(&gtk::Popover::builder().child(&calendar).build())
            .sensitive(false)
            .hexpand(true)
            .build();
        let show_day = {
            let day = day.clone();
            move |c: &gtk::Calendar| {
                day.set_label(
                    &c.date()
                        .format("%-d %B %Y")
                        .map(|s| s.to_string())
                        .unwrap_or_default(),
                );
            }
        };
        show_day(&calendar);
        calendar.connect_day_selected(move |c| {
            show_day(c);
            if let Some(p) = c.parent().and_downcast::<gtk::Popover>() {
                p.popdown();
            }
        });
        let d = day.clone();
        due.connect_toggled(move |due| d.set_sensitive(due.is_active()));
        let when = gtk::Box::builder().spacing(12).build();
        when.append(&due);
        when.append(&day);
        let body = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(12)
            .build();
        body.append(&entry);
        body.append(&when);

        let dialog = adw::AlertDialog::new(Some("New To-do"), None);
        dialog.set_extra_child(Some(&body));
        dialog.add_responses(&[("cancel", "Cancel"), ("add", "Add")]);
        dialog.set_response_appearance("add", adw::ResponseAppearance::Suggested);
        dialog.set_default_response(Some("add"));
        dialog.set_close_response("cancel");
        dialog.set_response_enabled("add", false);
        let d = dialog.clone();
        entry.connect_changed(move |e| {
            d.set_response_enabled("add", !e.text().trim().is_empty());
        });
        let weak = Rc::downgrade(self);
        dialog.connect_response(Some("add"), move |_, _| {
            let Some(i) = weak.upgrade() else { return };
            let item = entry.text().trim().to_string();
            let date = due.is_active().then(|| {
                calendar
                    .date()
                    .format("%Y-%m-%d")
                    .map(|s| s.to_string())
                    .unwrap_or_default()
            });
            let (weak, store) = (Rc::downgrade(&i), i.store.clone());
            glib::spawn_future_local(async move {
                let result = store.add_todo(&item, date.as_deref()).await;
                if let Some(i) = weak.upgrade() {
                    i.got(result);
                }
            });
        });
        dialog.present(Some(from));
    }
}
