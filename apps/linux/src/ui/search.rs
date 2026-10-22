// As SearchView on iOS. A message opens in its chat, out of incognito.
use std::cell::Cell;
use std::cell::RefCell;
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use hatbot::core::format;
use hatbot::core::links::Link;
use hatbot::core::models::{MessageLink, RoutineKind, SearchResults};
use hatbot::core::search;
use hatbot::store::Store;

use super::form::{error_label, note};
use super::route;
use super::shell::Banners;

pub struct Search {
    pub page: adw::NavigationPage,
    _inner: Rc<Inner>,
}

struct Inner {
    store: Store,
    entry: gtk::SearchEntry,
    prefs: adw::PreferencesPage,
    error: gtk::Label,
    groups: RefCell<Vec<adw::PreferencesGroup>>,
    /// Bumped by each search, so an older answer coming late is dropped.
    asked: Cell<u64>,
}

impl Search {
    pub fn new(store: &Store, banners: &Banners) -> Search {
        let entry = gtk::SearchEntry::builder()
            .placeholder_text("Search")
            .search_delay(250)
            .hexpand(true)
            .build();
        let header = adw::HeaderBar::new();
        header.set_title_widget(Some(
            &adw::Clamp::builder()
                .maximum_size(420)
                .child(&entry)
                .build(),
        ));
        let error = error_label();
        let top = adw::PreferencesGroup::new();
        top.add(&error);
        let prefs = adw::PreferencesPage::new();
        prefs.add(&top);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        banners.add(&view);
        view.set_content(Some(&prefs));
        let page = adw::NavigationPage::builder()
            .title("Search")
            .tag("search")
            .child(&view)
            .build();
        let inner = Rc::new(Inner {
            store: store.clone(),
            entry,
            prefs,
            error,
            groups: RefCell::default(),
            asked: Cell::new(0),
        });
        let weak = Rc::downgrade(&inner);
        inner.entry.connect_search_changed(move |_| {
            if let Some(i) = weak.upgrade() {
                i.search();
            }
        });
        let entry = inner.entry.clone();
        page.connect_shown(move |_| {
            entry.grab_focus();
        });
        Search {
            page,
            _inner: inner,
        }
    }
}

impl Inner {
    fn search(self: &Rc<Self>) {
        let q = self.entry.text().trim().to_string();
        let asked = self.asked.get() + 1;
        self.asked.set(asked);
        if q.chars().count() < 2 {
            self.error.set_visible(false);
            self.show(None);
            return;
        }
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.search(&q).await;
            let Some(i) = weak.upgrade() else { return };
            if i.asked.get() != asked {
                return;
            }
            match result {
                Ok(r) => {
                    i.error.set_visible(false);
                    i.show(Some(&r));
                }
                Err(e) => {
                    i.error.set_label(&e.message);
                    i.error.set_visible(true);
                }
            }
        });
    }

    fn show(&self, results: Option<&SearchResults>) {
        for g in self.groups.borrow_mut().drain(..) {
            self.prefs.remove(&g);
        }
        let Some(r) = results else { return };
        let mut groups = vec![];
        if r.is_empty() {
            let g = adw::PreferencesGroup::new();
            g.add(&note("Nothing found."));
            groups.push(g);
        }
        if !r.messages.is_empty() {
            let g = adw::PreferencesGroup::builder().title("Messages").build();
            let st = self.store.state();
            for m in &r.messages {
                let who = match &m.bot_id {
                    Some(b) => st.bot_name(Some(b)),
                    None => "You".into(),
                };
                let row = adw::ActionRow::builder()
                    .title(snippet_markup(&m.snippet))
                    .title_lines(3)
                    .subtitle(glib::markup_escape_text(&format!(
                        "{who}, {}",
                        format::stamp(&m.created_at)
                    )))
                    .activatable(true)
                    .build();
                let link = MessageLink {
                    conversation_id: m.conversation_id,
                    message_id: m.id,
                };
                row.connect_activated(move |_| route::reveal(link));
                g.add(&row);
            }
            groups.push(g);
        }
        if !r.tasks.is_empty() {
            let g = adw::PreferencesGroup::builder().title("Tasks").build();
            for t in &r.tasks {
                let id = t.id;
                g.add(&link_row(&t.title, None, move || route::go(Link::Task(id))));
            }
            groups.push(g);
        }
        if !r.memory.is_empty() {
            let g = adw::PreferencesGroup::builder().title("Memory").build();
            for m in &r.memory {
                let path = m.path.clone();
                let row = link_row(&m.text, Some(&m.path), move || {
                    route::go(Link::Memory(path.clone()))
                });
                row.set_title_lines(3);
                g.add(&row);
            }
            groups.push(g);
        }
        if !r.routines.is_empty() {
            let g = adw::PreferencesGroup::builder()
                .title("Schedules, triggers and watchers")
                .build();
            for x in &r.routines {
                let link = match x.kind {
                    RoutineKind::Schedule => Link::Schedule(x.id),
                    RoutineKind::Trigger => Link::Trigger(x.id),
                    RoutineKind::Watcher => Link::Watcher(x.id),
                };
                g.add(&link_row(&x.name, None, move || route::go(link.clone())));
            }
            groups.push(g);
        }
        for g in &groups {
            self.prefs.add(g);
        }
        self.groups.replace(groups);
    }
}

fn link_row(title: &str, subtitle: Option<&str>, open: impl Fn() + 'static) -> adw::ActionRow {
    let row = adw::ActionRow::builder()
        .title(title)
        .use_markup(false)
        .activatable(true)
        .build();
    if let Some(s) = subtitle {
        row.set_subtitle(s);
    }
    row.connect_activated(move |_| open());
    row
}

fn snippet_markup(snippet: &str) -> String {
    search::parts(snippet)
        .into_iter()
        .map(|(text, matched)| {
            let text = glib::markup_escape_text(&text);
            if matched {
                format!("<b>{text}</b>")
            } else {
                text.to_string()
            }
        })
        .collect()
}
