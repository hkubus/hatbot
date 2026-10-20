// Tasks: what needs you first (the desktop asking for you, approvals, questions), then the active or
// the finished tasks, newest first. Finished ones come a page at a time.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use hatbot::core::format;
use hatbot::core::links::Link;
use hatbot::core::models::Task;
use hatbot::store::{Change, Listener, Store};

use super::route;
use super::shell::Banners;
use super::task::status_label;
use super::tray::{approval_body, question_body};

pub struct Tasks {
    pub page: adw::NavigationPage,
    _inner: Rc<Inner>,
    _listener: Listener,
}

struct Inner {
    store: Store,
    done: Cell<bool>,
    /// The finished tasks loaded so far, once the first page has come.
    finished: RefCell<Option<Vec<i64>>>,
    more: Cell<bool>,
    loading: Cell<bool>,
    takeover: gtk::Button,
    asks: gtk::Box,
    /// What `asks` shows, so news about tasks leaves what you've written alone.
    asks_shown: RefCell<String>,
    list: gtk::ListBox,
    empty: gtk::Label,
    error: gtk::Label,
    spinner: adw::Spinner,
}

impl Tasks {
    pub fn new(store: &Store, banners: &Banners) -> Tasks {
        let filter = adw::ToggleGroup::new();
        for (name, label) in [("active", "Active"), ("done", "Finished")] {
            filter.add(adw::Toggle::builder().name(name).label(label).build());
        }
        filter.set_active_name(Some("active"));
        let header = adw::HeaderBar::builder().title_widget(&filter).build();

        let takeover = gtk::Button::builder()
            .visible(false)
            .css_classes(["card", "takeover"])
            .build();
        let asks = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(12)
            .build();
        let list = gtk::ListBox::builder()
            .selection_mode(gtk::SelectionMode::None)
            .css_classes(["boxed-list"])
            .build();
        let empty = gtk::Label::builder()
            .visible(false)
            .css_classes(["dim-label"])
            .margin_top(24)
            .build();
        let error = gtk::Label::builder()
            .visible(false)
            .wrap(true)
            .xalign(0.0)
            .css_classes(["error"])
            .build();
        let spinner = adw::Spinner::builder()
            .visible(false)
            .height_request(32)
            .build();
        let column = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(12)
            .margin_top(12)
            .margin_bottom(24)
            .margin_start(12)
            .margin_end(12)
            .build();
        for w in [
            error.upcast_ref::<gtk::Widget>(),
            takeover.upcast_ref(),
            asks.upcast_ref(),
            list.upcast_ref(),
            empty.upcast_ref(),
            spinner.upcast_ref(),
        ] {
            column.append(w);
        }
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vexpand(true)
            .child(
                &adw::Clamp::builder()
                    .maximum_size(720)
                    .child(&column)
                    .build(),
            )
            .build();
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        banners.add(&view);
        view.set_content(Some(&scroll));
        let page = adw::NavigationPage::builder()
            .title("Tasks")
            .tag("tasks")
            .child(&view)
            .build();

        let inner = Rc::new(Inner {
            store: store.clone(),
            done: Cell::new(false),
            finished: RefCell::default(),
            more: Cell::new(false),
            loading: Cell::new(false),
            takeover,
            asks,
            asks_shown: RefCell::default(),
            list,
            empty,
            error,
            spinner,
        });
        inner.list.connect_row_activated(|_, row| {
            if let Ok(id) = row.widget_name().parse() {
                route::go(Link::Task(id));
            }
        });
        let weak = Rc::downgrade(&inner);
        inner.takeover.connect_clicked(move |_| {
            let Some(i) = weak.upgrade() else { return };
            let id = i
                .store
                .state()
                .desktop
                .as_ref()
                .and_then(|d| d.request.as_ref())
                .map(|r| r.task_id);
            if let Some(id) = id {
                route::go(Link::Task(id));
            }
        });
        let weak = Rc::downgrade(&inner);
        filter.connect_active_name_notify(move |f| {
            let Some(i) = weak.upgrade() else { return };
            i.done.set(f.active_name().as_deref() == Some("done"));
            i.render();
            i.load();
        });
        let weak = Rc::downgrade(&inner);
        scroll.connect_edge_reached(move |_, edge| {
            if edge == gtk::PositionType::Bottom
                && let Some(i) = weak.upgrade()
            {
                i.load_more();
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
            if matches!(
                change,
                Change::Task(_) | Change::Tasks | Change::NeedsYou | Change::Desktop
            ) {
                i.render();
            }
        });
        inner.render();
        Tasks {
            page,
            _inner: inner,
            _listener: listener,
        }
    }
}

impl Inner {
    fn load(self: &Rc<Self>) {
        let (weak, done) = (Rc::downgrade(self), self.done.get());
        glib::spawn_future_local(async move {
            let Some(store) = weak.upgrade().map(|i| i.store.clone()) else {
                return;
            };
            let result = store.load_tasks(done, None).await;
            let Some(i) = weak.upgrade() else { return };
            match result {
                Ok(ids) => {
                    i.error.set_visible(false);
                    if done {
                        i.more.set(ids.len() == hatbot::store::PAGE);
                        i.finished.replace(Some(ids));
                    }
                }
                Err(e) => {
                    i.error.set_label(&e.message);
                    i.error.set_visible(true);
                }
            }
            i.render();
        });
    }

    fn load_more(self: &Rc<Self>) {
        let last = self
            .finished
            .borrow()
            .as_ref()
            .and_then(|f| f.last().copied());
        let Some(last) = last else { return };
        if !self.done.get() || !self.more.get() || self.loading.replace(true) {
            return;
        }
        let weak = Rc::downgrade(self);
        let store = self.store.clone();
        glib::spawn_future_local(async move {
            let result = store.load_tasks(true, Some(last)).await;
            let Some(i) = weak.upgrade() else { return };
            i.loading.set(false);
            if let Ok(ids) = result {
                i.more.set(ids.len() == hatbot::store::PAGE);
                if let Some(f) = i.finished.borrow_mut().as_mut() {
                    let new: Vec<i64> = ids.into_iter().filter(|id| !f.contains(id)).collect();
                    f.extend(new);
                }
            }
            i.render();
        });
    }

    fn render(&self) {
        let st = self.store.state();
        let request = st.desktop.as_ref().and_then(|d| d.request.clone());
        if let Some(r) = &request {
            self.takeover.set_child(Some(
                &gtk::Label::builder()
                    .use_markup(true)
                    .label(format!(
                        "<b>Hatbot needs you:</b> {}",
                        glib::markup_escape_text(&r.reason)
                    ))
                    .wrap(true)
                    .xalign(0.0)
                    .build(),
            ));
        }
        self.takeover.set_visible(request.is_some());

        let approvals = st.pending_approvals();
        let questions = st.pending_questions();
        let key = approvals
            .iter()
            .map(|a| format!("a{}", a.id))
            .chain(questions.iter().map(|q| format!("q{}", q.id)))
            .collect::<Vec<_>>()
            .join(",");
        if *self.asks_shown.borrow() != key {
            self.asks_shown.replace(key);
            while let Some(c) = self.asks.first_child() {
                self.asks.remove(&c);
            }
            let card = |body: gtk::Box| {
                body.add_css_class("card");
                body.add_css_class("tray");
                body
            };
            for a in &approvals {
                self.asks.append(&card(approval_body(&self.store, a, true)));
            }
            for q in &questions {
                self.asks.append(&card(question_body(&self.store, q, true)));
            }
        }

        let done = self.done.get();
        let finished = self.finished.borrow();
        let mut tasks: Vec<&Task> = st
            .tasks
            .values()
            .filter(|t| {
                if done {
                    !t.status.is_active() && finished.as_ref().is_some_and(|f| f.contains(&t.id))
                } else {
                    t.status.is_active()
                }
            })
            .collect();
        tasks.sort_by_key(|t| std::cmp::Reverse(t.id));
        self.list.remove_all();
        for t in &tasks {
            self.list.append(&row(t));
        }
        self.list.set_visible(!tasks.is_empty());
        self.empty.set_label(if done {
            "No tasks yet."
        } else {
            "Nothing running."
        });
        self.empty
            .set_visible(tasks.is_empty() && (!done || finished.is_some()));
        self.spinner.set_visible(done && self.more.get());
    }
}

fn row(t: &Task) -> gtk::ListBoxRow {
    let column = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(4)
        .margin_top(10)
        .margin_bottom(10)
        .margin_start(12)
        .margin_end(12)
        .build();
    column.append(
        &gtk::Label::builder()
            .label(&t.title)
            .xalign(0.0)
            .wrap(true)
            .lines(2)
            .ellipsize(gtk::pango::EllipsizeMode::End)
            .build(),
    );
    let line = gtk::Box::builder().spacing(6).build();
    let status = status_label(t.status);
    status.add_css_class("caption");
    line.append(&status);
    line.append(
        &gtk::Label::builder()
            .label(format::stamp(
                t.started_at.as_deref().unwrap_or(&t.created_at),
            ))
            .css_classes(["caption", "dim-label"])
            .build(),
    );
    column.append(&line);
    gtk::ListBoxRow::builder()
        .name(t.id.to_string())
        .activatable(true)
        .child(&column)
        .build()
}
