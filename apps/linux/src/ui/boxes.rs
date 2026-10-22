// As BoxesView on iOS. A box's page opens in the web app in your browser: its calls to Hatbot
// only work inside Hatbot, and this app has no web view.
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use adw::prelude::*;
use gtk::{gdk, gio, glib};
use hatbot::core::format;
use hatbot::core::links::Link;
use hatbot::core::models::{AppBox, BoxDetail};
use hatbot::store::{Change, Listener, Store};

use super::form::{confirm, error_label, note};
use super::icon::Icon;
use super::route;
use super::shell::Banners;

fn open_in_browser(store: &Store, id: i64) {
    let url = format!("{}/boxes/{id}", store.api().server());
    gtk::UriLauncher::new(&url).launch(None::<&gtk::Window>, gtk::gio::Cancellable::NONE, |_| {});
}

/// Swaps the groups a page shows below its top one.
fn replace(
    prefs: &adw::PreferencesPage,
    old: &RefCell<Vec<adw::PreferencesGroup>>,
    new: Vec<adw::PreferencesGroup>,
) {
    // Focus left inside a removed group moves to the page's first row, and the page scrolls up.
    if let Some(root) = prefs.root()
        && let Some(f) = root.focus()
        && old.borrow().iter().any(|g| f.is_ancestor(g))
    {
        root.set_focus(None::<&gtk::Widget>);
    }
    for g in old.borrow_mut().drain(..) {
        prefs.remove(&g);
    }
    for g in &new {
        prefs.add(g);
    }
    old.replace(new);
}

pub struct Boxes {
    pub page: adw::NavigationPage,
    _inner: Rc<List>,
    _listener: Listener,
    dark: Option<glib::SignalHandlerId>,
}

impl Drop for Boxes {
    fn drop(&mut self) {
        if let Some(id) = self.dark.take() {
            adw::StyleManager::default().disconnect(id);
        }
    }
}

/// A preview is of one version of a box, in light or dark.
type Key = (i64, i64, bool);

struct List {
    store: Store,
    grid: gtk::FlowBox,
    empty: gtk::Label,
    error: gtk::Label,
    spinner: adw::Spinner,
    /// None when the brain has no picture.
    previews: RefCell<HashMap<Key, Option<gdk::Texture>>>,
    fetching: RefCell<HashSet<Key>>,
    shown: RefCell<HashMap<Key, (gtk::Picture, Icon)>>,
}

impl Boxes {
    pub fn new(store: &Store, banners: &Banners) -> Boxes {
        let error = error_label();
        let spinner = adw::Spinner::builder().height_request(32).build();
        let empty =
            note("No boxes yet. Ask Hatbot for a tracker, a calculator or a planner to keep.");
        empty.set_visible(false);
        let grid = gtk::FlowBox::builder()
            .min_children_per_line(3)
            .max_children_per_line(3)
            .homogeneous(true)
            .selection_mode(gtk::SelectionMode::None)
            .row_spacing(18)
            .column_spacing(18)
            .valign(gtk::Align::Start)
            .css_classes(["box-grid"])
            .build();
        grid.connect_child_activated(|_, child| {
            if let Ok(id) = child.widget_name().parse() {
                route::go(Link::Box(id));
            }
        });
        let column = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(12)
            .margin_top(18)
            .margin_bottom(24)
            .margin_start(18)
            .margin_end(18)
            .build();
        column.append(&error);
        column.append(&spinner);
        column.append(&empty);
        column.append(&grid);
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vexpand(true)
            .child(
                &adw::Clamp::builder()
                    .maximum_size(1100)
                    .child(&column)
                    .build(),
            )
            .build();
        let view = adw::ToolbarView::new();
        view.add_top_bar(&adw::HeaderBar::new());
        banners.add(&view);
        view.set_content(Some(&scroll));
        let page = adw::NavigationPage::builder()
            .title("Boxes")
            .tag("boxes")
            .child(&view)
            .build();
        let inner = Rc::new(List {
            store: store.clone(),
            grid,
            empty,
            error,
            spinner,
            previews: RefCell::default(),
            fetching: RefCell::default(),
            shown: RefCell::default(),
        });
        let weak = Rc::downgrade(&inner);
        page.connect_showing(move |_| {
            if let Some(l) = weak.upgrade() {
                l.load();
            }
        });
        let weak = Rc::downgrade(&inner);
        let listener = store.listen(move |change| {
            if let (Some(l), Change::Box(_) | Change::Boxes) = (weak.upgrade(), change)
                && l.store.state().boxes_loaded
            {
                l.render();
            }
        });
        let weak = Rc::downgrade(&inner);
        let dark = adw::StyleManager::default().connect_dark_notify(move |_| {
            if let Some(l) = weak.upgrade() {
                l.render();
            }
        });
        inner.render();
        Boxes {
            page,
            _inner: inner,
            _listener: listener,
            dark: Some(dark),
        }
    }
}

impl List {
    fn load(self: &Rc<Self>) {
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let result = store.load_boxes().await;
            let Some(l) = weak.upgrade() else { return };
            l.spinner.set_visible(false);
            match result {
                Ok(()) => l.error.set_visible(false),
                Err(e) => {
                    l.error.set_label(&e.message);
                    l.error.set_visible(true);
                }
            }
        });
    }

    fn render(self: &Rc<Self>) {
        let mut list: Vec<_> = {
            let st = self.store.state();
            if !st.boxes_loaded {
                return;
            }
            st.boxes.values().cloned().collect()
        };
        self.spinner.set_visible(false);
        self.empty.set_visible(list.is_empty());
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(b.id.cmp(&a.id)));
        let dark = adw::StyleManager::default().is_dark();
        self.grid.remove_all();
        let mut shown = HashMap::new();
        for b in list {
            let key = (b.id, b.version, dark);
            let (child, picture, placeholder) = card(&b);
            self.grid.append(&child);
            match self.previews.borrow().get(&key) {
                Some(Some(texture)) => {
                    picture.set_paintable(Some(texture));
                    placeholder.set_visible(false);
                }
                Some(None) => {}
                None => self.fetch(key),
            }
            shown.insert(key, (picture, placeholder));
        }
        self.shown.replace(shown);
    }

    fn fetch(self: &Rc<Self>, key: Key) {
        if !self.fetching.borrow_mut().insert(key) {
            return;
        }
        let (weak, store) = (Rc::downgrade(self), self.store.clone());
        glib::spawn_future_local(async move {
            let (id, version, dark) = key;
            let result = store.box_preview(id, version, dark).await;
            let texture = match result {
                Ok(Some(bytes)) => gio::spawn_blocking(move || top(&bytes))
                    .await
                    .ok()
                    .flatten(),
                Ok(None) => None,
                // Tried again on the next render.
                Err(_) => {
                    if let Some(l) = weak.upgrade() {
                        l.fetching.borrow_mut().remove(&key);
                    }
                    return;
                }
            };
            let Some(l) = weak.upgrade() else { return };
            l.fetching.borrow_mut().remove(&key);
            if let (Some(t), Some((picture, placeholder))) = (&texture, l.shown.borrow().get(&key))
            {
                picture.set_paintable(Some(t));
                placeholder.set_visible(false);
            }
            l.previews.borrow_mut().insert(key, texture);
        });
    }
}

/// The top of a page's picture, cut to the card's 16:10.
fn top(png: &glib::Bytes) -> Option<gdk::Texture> {
    let texture = gdk::Texture::from_bytes(png).ok()?;
    let (w, h) = (texture.width(), texture.height());
    let cut = (w * 10 / 16).max(1);
    if h <= cut {
        return Some(texture);
    }
    let mut downloader = gdk::TextureDownloader::new(&texture);
    downloader.set_format(gdk::MemoryFormat::R8g8b8a8Premultiplied);
    let (data, stride) = downloader.download_bytes();
    let rows = glib::Bytes::from_bytes(&data, ..stride * cut as usize);
    Some(
        gdk::MemoryTexture::new(
            w,
            cut,
            gdk::MemoryFormat::R8g8b8a8Premultiplied,
            &rows,
            stride,
        )
        .upcast(),
    )
}

fn card(b: &AppBox) -> (gtk::FlowBoxChild, gtk::Picture, Icon) {
    // An empty 16:10 paintable gives the preview its height for the card's width.
    let frame = gtk::Picture::builder()
        .paintable(&gdk::Paintable::new_empty(16, 10))
        .can_shrink(true)
        .content_fit(gtk::ContentFit::Fill)
        .build();
    let placeholder = Icon::new("box", 28);
    placeholder.set_halign(gtk::Align::Center);
    placeholder.set_valign(gtk::Align::Center);
    placeholder.add_css_class("dim-label");
    let picture = gtk::Picture::builder()
        .can_shrink(true)
        .content_fit(gtk::ContentFit::Cover)
        .build();
    let preview = gtk::Overlay::builder()
        .child(&frame)
        .overflow(gtk::Overflow::Hidden)
        .css_classes(["box-preview"])
        .build();
    preview.add_overlay(&placeholder);
    preview.add_overlay(&picture);
    let title = gtk::Label::builder()
        .label(&b.title)
        .xalign(0.0)
        .ellipsize(gtk::pango::EllipsizeMode::End)
        .css_classes(["heading"])
        .build();
    let stamp = gtk::Label::builder()
        .label(format::stamp(&b.updated_at))
        .xalign(0.0)
        .css_classes(["caption", "dim-label"])
        .build();
    let text = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(2)
        .margin_top(10)
        .margin_bottom(12)
        .margin_start(12)
        .margin_end(12)
        .build();
    text.append(&title);
    text.append(&stamp);
    let card = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .overflow(gtk::Overflow::Hidden)
        .css_classes(["box-card"])
        .build();
    card.append(&preview);
    card.append(&text);
    let child = gtk::FlowBoxChild::builder()
        .name(b.id.to_string())
        .child(&card)
        .build();
    child.update_property(&[gtk::accessible::Property::Label(&b.title)]);
    (child, picture, placeholder)
}

pub struct BoxPage {
    pub page: adw::NavigationPage,
    _inner: Rc<Page>,
    _listener: Listener,
}

struct Page {
    store: Store,
    id: i64,
    page: adw::NavigationPage,
    prefs: adw::PreferencesPage,
    open: gtk::Button,
    error: gtk::Label,
    groups: RefCell<Vec<adw::PreferencesGroup>>,
    detail: RefCell<Option<BoxDetail>>,
    busy: Cell<bool>,
}

impl BoxPage {
    pub fn new(store: &Store, id: i64) -> BoxPage {
        let open = gtk::Button::builder()
            .label("Open in Browser")
            .css_classes(["suggested-action"])
            .build();
        let header = adw::HeaderBar::new();
        header.pack_end(&open);
        let error = error_label();
        let top = adw::PreferencesGroup::new();
        top.add(&error);
        let prefs = adw::PreferencesPage::new();
        prefs.add(&top);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        view.set_content(Some(&prefs));
        let title = store
            .state()
            .boxes
            .get(&id)
            .map_or("Box".to_string(), |b| b.title.clone());
        let page = adw::NavigationPage::builder()
            .title(title)
            .child(&view)
            .build();
        let inner = Rc::new(Page {
            store: store.clone(),
            id,
            page: page.clone(),
            prefs,
            open: open.clone(),
            error,
            groups: RefCell::default(),
            detail: RefCell::default(),
            busy: Cell::new(false),
        });
        let s = store.clone();
        open.connect_clicked(move |_| open_in_browser(&s, id));
        let weak = Rc::downgrade(&inner);
        let listener = store.listen(move |change| {
            let Some(p) = weak.upgrade() else { return };
            // While restoring or deleting, the answer shows what changed.
            if p.busy.get() || (*change != Change::Box(p.id) && *change != Change::Boxes) {
                return;
            }
            let (now, deleted) = {
                let st = p.store.state();
                (
                    st.boxes.get(&p.id).map(|b| b.updated_at.clone()),
                    st.deleted_boxes.contains(&p.id),
                )
            };
            let shown = p.detail.borrow().as_ref().map(|d| d.app.updated_at.clone());
            if deleted {
                p.detail.replace(None);
                p.render();
            } else if now.is_some() && now != shown {
                p.load();
            }
        });
        inner.load();
        BoxPage {
            page,
            _inner: inner,
            _listener: listener,
        }
    }
}

impl Page {
    fn show_error(&self, text: &str) {
        self.error.set_label(text);
        self.error.set_visible(true);
    }

    fn load(self: &Rc<Self>) {
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.load_box(id).await;
            let Some(p) = weak.upgrade() else { return };
            match result {
                Ok(d) => {
                    p.error.set_visible(false);
                    p.detail.replace(d);
                    p.render();
                }
                Err(e) => p.show_error(&e.message),
            }
        });
    }

    fn render(self: &Rc<Self>) {
        let Some(d) = self.detail.borrow().clone() else {
            if self.store.state().deleted_boxes.contains(&self.id) {
                self.open.set_visible(false);
                let g = adw::PreferencesGroup::new();
                g.add(&note("This box was deleted."));
                replace(&self.prefs, &self.groups, vec![g]);
            }
            return;
        };
        self.page.set_title(&d.app.title);
        let versions = adw::PreferencesGroup::builder().title("Versions").build();
        for v in d.versions.iter().rev() {
            let row = adw::ActionRow::builder()
                .title(format!("Version {}", v.n))
                .subtitle(format::stamp(&v.created_at))
                .activatable(true)
                .build();
            if v.n != d.app.version {
                let restore = gtk::Button::builder()
                    .label("Restore")
                    .valign(gtk::Align::Center)
                    .sensitive(!self.busy.get())
                    .build();
                let (weak, n) = (Rc::downgrade(self), v.n);
                restore.connect_clicked(move |_| {
                    if let Some(p) = weak.upgrade() {
                        p.restore(n);
                    }
                });
                row.add_suffix(&restore);
            }
            row.add_suffix(&gtk::Image::from_icon_name("go-next-symbolic"));
            let (store, id, n) = (self.store.clone(), self.id, v.n);
            row.connect_activated(move |_| {
                let p = CodePage::new(&store, id, n);
                route::push(p.page.clone(), Box::new(p));
            });
            versions.add(&row);
        }
        let delete = adw::ButtonRow::builder()
            .title("Delete Box")
            .sensitive(!self.busy.get())
            .build();
        delete.add_css_class("destructive-action");
        let weak = Rc::downgrade(self);
        delete.connect_activated(move |row| {
            let weak = weak.clone();
            confirm(
                row,
                "Delete this box? Every version and what it saved go with it.",
                "Delete",
                move || {
                    if let Some(p) = weak.upgrade() {
                        p.delete();
                    }
                },
            );
        });
        let end = adw::PreferencesGroup::new();
        end.add(&delete);
        replace(&self.prefs, &self.groups, vec![versions, end]);
    }

    fn restore(self: &Rc<Self>, version: i64) {
        if self.busy.replace(true) {
            return;
        }
        self.render();
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.restore_box(id, version).await;
            let Some(p) = weak.upgrade() else { return };
            p.busy.set(false);
            match result {
                Ok(d) => {
                    p.error.set_visible(false);
                    p.detail.replace(Some(d));
                }
                Err(e) => p.show_error(&e.message),
            }
            p.render();
        });
    }

    fn delete(self: &Rc<Self>) {
        if self.busy.replace(true) {
            return;
        }
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.delete_box(id).await;
            let Some(p) = weak.upgrade() else { return };
            p.busy.set(false);
            match result {
                Ok(()) => {
                    let _ = p.page.activate_action("navigation.pop", None);
                }
                Err(e) => p.show_error(&e.message),
            }
        });
    }
}

pub struct CodePage {
    pub page: adw::NavigationPage,
}

impl CodePage {
    pub fn new(store: &Store, id: i64, version: i64) -> CodePage {
        let buffer = gtk::TextBuffer::new(None);
        let view = gtk::TextView::builder()
            .buffer(&buffer)
            .editable(false)
            .cursor_visible(false)
            .monospace(true)
            .top_margin(12)
            .bottom_margin(12)
            .left_margin(12)
            .right_margin(12)
            .build();
        let error = error_label();
        error.set_margin_top(12);
        error.set_margin_start(12);
        let spinner = adw::Spinner::builder()
            .height_request(32)
            .valign(gtk::Align::Center)
            .vexpand(true)
            .build();
        let scrolled = gtk::ScrolledWindow::builder()
            .child(&view)
            .vexpand(true)
            .visible(false)
            .build();
        let column = gtk::Box::new(gtk::Orientation::Vertical, 0);
        column.append(&error);
        column.append(&spinner);
        column.append(&scrolled);
        let toolbar = adw::ToolbarView::new();
        toolbar.add_top_bar(&adw::HeaderBar::new());
        toolbar.set_content(Some(&column));
        let page = adw::NavigationPage::builder()
            .title(format!("Version {version}"))
            .child(&toolbar)
            .build();
        let store = store.clone();
        glib::spawn_future_local(async move {
            let result = store.box_page(id, version).await;
            spinner.set_visible(false);
            match result {
                Ok(p) => {
                    buffer.set_text(&p.code());
                    scrolled.set_visible(true);
                }
                Err(e) => {
                    error.set_label(&e.message);
                    error.set_visible(true);
                }
            }
        });
        CodePage { page }
    }
}
