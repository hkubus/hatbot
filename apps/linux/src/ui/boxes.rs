// As BoxesView on iOS. A box's page runs in a web view on an opaque origin with no network, and what
// it asks of Hatbot goes through the app to the brain, which checks it.
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use adw::prelude::*;
use gtk::{gdk, gio, glib};
use hatbot::core::boxes::{self, Navigation};
use hatbot::core::format;
use hatbot::core::links::Link;
use hatbot::core::models::{AppBox, BoxDetail};
use hatbot::store::{Change, Listener, Store};
use webkit::javascriptcore as jsc;
use webkit::prelude::*;

use super::form::{confirm, error_label, note};
use super::icon::Icon;
use super::route;
use super::shell::Banners;

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
    dark: Option<glib::SignalHandlerId>,
}

impl Drop for BoxPage {
    fn drop(&mut self) {
        if let Some(id) = self.dark.take() {
            adw::StyleManager::default().disconnect(id);
        }
    }
}

struct Page {
    store: Store,
    id: i64,
    page: adw::NavigationPage,
    stack: gtk::Stack,
    holder: adw::Bin,
    status: adw::StatusPage,
    status_button: gtk::Button,
    error: gtk::Label,
    restore: gtk::Button,
    versions: gtk::MenuButton,
    more: gtk::MenuButton,
    version_action: gio::SimpleAction,
    delete_action: gio::SimpleAction,
    detail: RefCell<Option<BoxDetail>>,
    /// The version you picked to look at; None follows the current one.
    picked: Cell<Option<i64>>,
    /// The version the view shows or is opening, and when the box last changed.
    shown: RefCell<Option<(i64, String)>>,
    frame: RefCell<Option<Rc<Frame>>>,
    /// Counts opens, so the answer to an older one is dropped.
    opens: Cell<u64>,
    /// The status page's button reads the box again rather than reloading its page.
    retry_detail: Cell<bool>,
    busy: Cell<bool>,
}

/// A box's page in a web view of its own.
struct Frame {
    web: webkit::WebView,
    address: String,
    /// The page has come: from then on it moves only within itself.
    loaded: Cell<bool>,
    /// It has finished loading, so its script is there to take the theme.
    ready: Cell<bool>,
    dark: Cell<bool>,
    /// It left its page or failed: nothing it asks is answered.
    over: Cell<bool>,
}

impl BoxPage {
    pub fn new(store: &Store, id: i64) -> BoxPage {
        let restore = gtk::Button::builder()
            .label("Restore")
            .visible(false)
            .build();
        let versions = gtk::MenuButton::builder()
            .icon_name("document-open-recent-symbolic")
            .tooltip_text("Versions")
            .visible(false)
            .build();
        let more_menu = gio::Menu::new();
        more_menu.append(Some("Code"), Some("box.code"));
        more_menu.append(Some("Delete"), Some("box.delete"));
        let more = gtk::MenuButton::builder()
            .icon_name("view-more-symbolic")
            .tooltip_text("More")
            .menu_model(&more_menu)
            .visible(false)
            .build();
        let header = adw::HeaderBar::new();
        header.pack_end(&more);
        header.pack_end(&versions);
        header.pack_end(&restore);
        let error = error_label();
        error.set_margin_top(6);
        error.set_margin_bottom(6);
        error.set_margin_start(12);
        error.set_margin_end(12);
        let status_button = gtk::Button::builder()
            .label("Reload")
            .halign(gtk::Align::Center)
            .css_classes(["pill"])
            .build();
        let status = adw::StatusPage::builder().child(&status_button).build();
        let holder = adw::Bin::new();
        let stack = gtk::Stack::builder().vexpand(true).build();
        stack.add_named(
            &adw::Spinner::builder()
                .height_request(32)
                .valign(gtk::Align::Center)
                .build(),
            Some("loading"),
        );
        stack.add_named(&holder, Some("web"));
        stack.add_named(&status, Some("status"));
        let column = gtk::Box::new(gtk::Orientation::Vertical, 0);
        column.append(&error);
        column.append(&stack);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        view.set_content(Some(&column));
        let known = store.state().boxes.get(&id).cloned();
        let page = adw::NavigationPage::builder()
            .title(known.as_ref().map_or("Box", |b| &b.title))
            .child(&view)
            .build();
        let version_action = gio::SimpleAction::new_stateful(
            "version",
            Some(glib::VariantTy::INT64),
            &0i64.to_variant(),
        );
        let delete_action = gio::SimpleAction::new("delete", None);
        let inner = Rc::new(Page {
            store: store.clone(),
            id,
            page: page.clone(),
            stack,
            holder,
            status,
            status_button,
            error,
            restore,
            versions,
            more,
            version_action,
            delete_action,
            detail: RefCell::default(),
            picked: Cell::new(None),
            shown: RefCell::default(),
            frame: RefCell::default(),
            opens: Cell::new(0),
            retry_detail: Cell::new(false),
            busy: Cell::new(false),
        });
        inner.connect();
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
            let read = p.detail.borrow().as_ref().map(|d| d.app.updated_at.clone());
            if deleted {
                p.detail.replace(None);
                p.render();
            } else if now.is_some() && now != read {
                p.load();
            }
        });
        let weak = Rc::downgrade(&inner);
        let dark = adw::StyleManager::default().connect_dark_notify(move |styles| {
            if let Some(f) = weak.upgrade().and_then(|p| p.frame.borrow().clone()) {
                f.follow_theme(styles.is_dark());
            }
        });
        // From the boxes list, the page starts loading alongside the details.
        if let Some(b) = known {
            inner.show(b.version, &b.updated_at);
        }
        inner.load();
        BoxPage {
            page,
            _inner: inner,
            _listener: listener,
            dark: Some(dark),
        }
    }
}

impl Page {
    fn connect(self: &Rc<Self>) {
        let actions = gio::SimpleActionGroup::new();
        let weak = Rc::downgrade(self);
        self.version_action.connect_activate(move |action, n| {
            let (Some(p), Some(n)) = (weak.upgrade(), n.and_then(|n| n.get::<i64>())) else {
                return;
            };
            action.set_state(&n.to_variant());
            let current = p.detail.borrow().as_ref().map(|d| d.app.version);
            p.picked.set((current != Some(n)).then_some(n));
            p.render();
        });
        actions.add_action(&self.version_action);
        let code = gio::SimpleAction::new("code", None);
        let weak = Rc::downgrade(self);
        code.connect_activate(move |_, _| {
            let Some(p) = weak.upgrade() else { return };
            if let Some((version, _)) = p.shown.borrow().clone() {
                let c = CodePage::new(&p.store, p.id, version);
                route::push(c.page.clone(), Box::new(c));
            }
        });
        actions.add_action(&code);
        let weak = Rc::downgrade(self);
        self.delete_action.connect_activate(move |_, _| {
            let Some(p) = weak.upgrade() else { return };
            let weak = Rc::downgrade(&p);
            confirm(
                &p.page,
                "Delete this box? Every version and what it saved go with it.",
                "Delete",
                move || {
                    if let Some(p) = weak.upgrade() {
                        p.delete();
                    }
                },
            );
        });
        actions.add_action(&self.delete_action);
        self.page.insert_action_group("box", Some(&actions));

        let weak = Rc::downgrade(self);
        self.restore.connect_clicked(move |_| {
            if let Some(p) = weak.upgrade()
                && let Some(n) = p.picked.get()
            {
                p.restore(n);
            }
        });
        let weak = Rc::downgrade(self);
        self.status_button.connect_clicked(move |_| {
            let Some(p) = weak.upgrade() else { return };
            if p.retry_detail.get() {
                p.stack.set_visible_child_name("loading");
                p.load();
            } else if let Some((version, changed)) = p.shown.take() {
                p.show(version, &changed);
            }
        });
    }

    fn show_error(&self, text: &str) {
        self.error.set_label(text);
        self.error.set_visible(true);
    }

    fn show_status(&self, text: &str, button: Option<&str>) {
        self.status.set_title(text);
        self.status_button.set_visible(button.is_some());
        if let Some(label) = button {
            self.status_button.set_label(label);
        }
        self.stack.set_visible_child_name("status");
    }

    fn load(self: &Rc<Self>) {
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.load_box(id).await;
            let Some(p) = weak.upgrade() else { return };
            match result {
                Ok(d) => {
                    p.error.set_visible(false);
                    p.retry_detail.set(false);
                    p.detail.replace(d);
                    p.render();
                }
                Err(e) if p.shown.borrow().is_none() => {
                    p.retry_detail.set(true);
                    p.show_status(&e.message, Some("Retry"));
                }
                Err(e) => p.show_error(&e.message),
            }
        });
    }

    fn render(self: &Rc<Self>) {
        let Some(d) = self.detail.borrow().clone() else {
            if self.store.state().deleted_boxes.contains(&self.id) {
                for w in [
                    self.restore.upcast_ref::<gtk::Widget>(),
                    self.versions.upcast_ref(),
                    self.more.upcast_ref(),
                ] {
                    w.set_visible(false);
                }
                self.close_frame();
                self.opens.set(self.opens.get() + 1);
                self.show_status("This box was deleted.", None);
            }
            return;
        };
        self.page.set_title(&d.app.title);
        let version = self.picked.get().unwrap_or(d.app.version);
        self.restore.set_visible(version != d.app.version);
        self.restore.set_sensitive(!self.busy.get());
        self.delete_action.set_enabled(!self.busy.get());
        self.more.set_visible(true);
        self.versions.set_visible(d.versions.len() > 1);
        let menu = gio::Menu::new();
        for v in d.versions.iter().rev() {
            let item = gio::MenuItem::new(
                Some(&format!(
                    "Version {}, {}",
                    v.n,
                    format::stamp(&v.created_at)
                )),
                None,
            );
            item.set_action_and_target_value(Some("box.version"), Some(&v.n.to_variant()));
            menu.append_item(&item);
        }
        self.versions.set_menu_model(Some(&menu));
        self.version_action.set_state(&version.to_variant());
        self.show(version, &d.app.updated_at);
    }

    /// Opens a version's page, unless it's what the view already shows.
    fn show(self: &Rc<Self>, version: i64, changed: &str) {
        let key = (version, changed.to_string());
        if self.shown.borrow().as_ref() == Some(&key) {
            return;
        }
        self.shown.replace(Some(key));
        self.close_frame();
        self.stack.set_visible_child_name("loading");
        let n = self.opens.get() + 1;
        self.opens.set(n);
        let dark = adw::StyleManager::default().is_dark();
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.open_box(id, version, dark).await;
            let Some(p) = weak.upgrade() else { return };
            if p.opens.get() != n {
                return;
            }
            match result {
                Ok(address) => p.start(address, dark),
                Err(e) => {
                    p.retry_detail.set(false);
                    p.show_status(&e.message, Some("Reload"));
                }
            }
        });
    }

    fn close_frame(&self) {
        if let Some(f) = self.frame.take() {
            f.over.set(true);
            f.web.stop_loading();
            self.holder.set_child(None::<&gtk::Widget>);
        }
    }

    /// Stops the page with a reason and a Reload button. Called from the web view's own signals, so
    /// the view goes once they've returned.
    fn fail(self: &Rc<Self>, frame: &Frame, text: &str) {
        if frame.over.replace(true) {
            return;
        }
        self.retry_detail.set(false);
        self.show_status(text, Some("Reload"));
        let weak = Rc::downgrade(self);
        let web = frame.web.clone();
        glib::idle_add_local_once(move || {
            if let Some(p) = weak.upgrade()
                && p.frame.borrow().as_ref().is_some_and(|f| f.web == web)
            {
                p.close_frame();
            }
        });
    }

    fn start(self: &Rc<Self>, address: String, dark: bool) {
        let frame = Rc::new(Frame {
            web: web_view(),
            address,
            loaded: Cell::new(false),
            ready: Cell::new(false),
            dark: Cell::new(dark),
            over: Cell::new(false),
        });
        self.watch(&frame);
        self.holder.set_child(Some(&frame.web));
        self.stack.set_visible_child_name("web");
        frame.web.load_uri(&frame.address);
        self.frame.replace(Some(frame));
    }

    fn watch(self: &Rc<Self>, frame: &Rc<Frame>) {
        let (weak, wf) = (Rc::downgrade(self), Rc::downgrade(frame));
        frame.web.connect_decide_policy(move |_, decision, kind| {
            let (Some(p), Some(f)) = (weak.upgrade(), wf.upgrade()) else {
                decision.ignore();
                return true;
            };
            if kind == webkit::PolicyDecisionType::Response {
                let Some(r) = decision.downcast_ref::<webkit::ResponsePolicyDecision>() else {
                    return false;
                };
                let status = r.response().map_or(0, |r| r.status_code());
                if !r.is_main_frame_main_resource() || status == 200 {
                    return false;
                }
                decision.ignore();
                let text = if status == 403 {
                    "This link has expired."
                } else {
                    "Couldn't open this box."
                };
                p.fail(&f, text);
                return true;
            }
            let action = decision
                .downcast_ref::<webkit::NavigationPolicyDecision>()
                .and_then(|d| d.navigation_action());
            let Some(action) = action else {
                decision.ignore();
                return true;
            };
            let url = action
                .request()
                .and_then(|r| r.uri())
                .map(|u| u.to_string())
                .unwrap_or_default();
            let new_window = kind == webkit::PolicyDecisionType::NewWindowAction;
            let link = action.navigation_type() == webkit::NavigationType::LinkClicked;
            match boxes::decide(&url, new_window, link, &f.address, f.loaded.get()) {
                Navigation::Allow => decision.use_(),
                Navigation::Open(page) => {
                    decision.ignore();
                    gtk::UriLauncher::new(&page).launch(
                        p.page.root().and_downcast_ref::<gtk::Window>(),
                        gio::Cancellable::NONE,
                        |_| {},
                    );
                }
                Navigation::Refuse => decision.ignore(),
                Navigation::Leave => {
                    decision.ignore();
                    p.fail(&f, "This box left its page.");
                }
            }
            true
        });
        let (weak, wf) = (Rc::downgrade(self), Rc::downgrade(frame));
        frame.web.connect_load_changed(move |web, event| {
            let (Some(p), Some(f)) = (weak.upgrade(), wf.upgrade()) else {
                return;
            };
            match event {
                webkit::LoadEvent::Committed => {
                    f.loaded.set(true);
                    let uri = web.uri().unwrap_or_default();
                    if !boxes::same_page(&uri, &f.address) {
                        p.fail(&f, "This box left its page.");
                    }
                }
                webkit::LoadEvent::Finished => {
                    f.ready.set(true);
                    // The theme may have changed while the page loaded.
                    f.follow_theme(adw::StyleManager::default().is_dark());
                }
                _ => {}
            }
        });
        let (weak, wf) = (Rc::downgrade(self), Rc::downgrade(frame));
        frame.web.connect_load_failed(move |_, _, _, error| {
            let (Some(p), Some(f)) = (weak.upgrade(), wf.upgrade()) else {
                return true;
            };
            // Refused here, which already says why, or stopped for a newer load.
            if f.over.get()
                || error.matches(webkit::NetworkError::Cancelled)
                || error.matches(webkit::PolicyError::FrameLoadInterruptedByPolicyChange)
            {
                return true;
            }
            p.fail(&f, "Couldn't open this box.");
            true
        });
        let (weak, wf) = (Rc::downgrade(self), Rc::downgrade(frame));
        frame.web.connect_web_process_terminated(move |_, _| {
            if let (Some(p), Some(f)) = (weak.upgrade(), wf.upgrade()) {
                p.fail(&f, "This box stopped.");
            }
        });
        let Some(content) = frame.web.user_content_manager() else {
            return;
        };
        content.register_script_message_handler_with_reply("hatbox", None);
        let (store, id, wf) = (self.store.clone(), self.id, Rc::downgrade(frame));
        content.connect_script_message_with_reply_received(
            Some("hatbox"),
            move |_, call, reply| {
                answer(&store, id, &wf, call, reply);
                true
            },
        );
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
                    p.picked.set(None);
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
        self.render();
        let (weak, store, id) = (Rc::downgrade(self), self.store.clone(), self.id);
        glib::spawn_future_local(async move {
            let result = store.delete_box(id).await;
            let Some(p) = weak.upgrade() else { return };
            p.busy.set(false);
            match result {
                Ok(()) => {
                    let _ = p.page.activate_action("navigation.pop", None);
                }
                Err(e) => {
                    p.show_error(&e.message);
                    p.render();
                }
            }
        });
    }
}

impl Frame {
    fn follow_theme(&self, dark: bool) {
        if !self.ready.get() || self.over.get() || self.dark.replace(dark) == dark {
            return;
        }
        self.web.evaluate_javascript(
            &format!("window.__hatboxTheme({dark})"),
            None,
            None,
            gio::Cancellable::NONE,
            |_| {},
        );
    }
}

/// A call from the box's page, passed on as it came for the brain to check. Only the box's own page
/// is answered, and only while it's showing.
fn answer(
    store: &Store,
    id: i64,
    frame: &std::rc::Weak<Frame>,
    call: &jsc::Value,
    reply: &webkit::ScriptMessageReply,
) {
    let showing = frame.upgrade().is_some_and(|f| {
        !f.over.get() && boxes::same_page(&f.web.uri().unwrap_or_default(), &f.address)
    });
    if !showing {
        return reply.return_error_message("Open this box in Hatbot.");
    }
    // As the web app's JSON.stringify sends it: dates as ISO strings, NaN and infinities as null.
    let json = (call.is_object() && !call.is_array())
        .then(|| call.to_json(0))
        .flatten()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    let (Some(json), Some(context)) = (json, call.context()) else {
        return reply.return_error_message("That isn't a value a box can keep.");
    };
    let (store, frame, reply) = (store.clone(), frame.clone(), reply.clone());
    glib::spawn_future_local(async move {
        let result = store.call_box(id, &json).await;
        if frame.upgrade().is_none_or(|f| f.over.get()) {
            return reply.return_error_message("Open this box in Hatbot.");
        }
        match result {
            Ok(Some(value)) => {
                reply.return_value(&jsc::Value::from_json(&context, &value.to_string()))
            }
            Ok(None) => reply.return_value(&jsc::Value::new_undefined(&context)),
            Err(e) => reply.return_error_message(&e.message),
        }
    });
}

/// A web view that keeps nothing, reaches no files, asks for no permissions and downloads nothing.
fn web_view() -> webkit::WebView {
    let settings = webkit::Settings::new();
    settings.set_enable_developer_extras(cfg!(debug_assertions));
    settings.set_allow_file_access_from_file_urls(false);
    settings.set_allow_universal_access_from_file_urls(false);
    settings.set_allow_top_navigation_to_data_urls(false);
    settings.set_javascript_can_open_windows_automatically(false);
    settings.set_enable_back_forward_navigation_gestures(false);
    settings.set_enable_hyperlink_auditing(false);
    settings.set_enable_dns_prefetching(false);
    settings.set_enable_html5_database(false);
    settings.set_enable_html5_local_storage(false);
    settings.set_enable_page_cache(false);
    settings.set_enable_media_stream(false);
    settings.set_enable_webrtc(false);
    settings.set_enable_encrypted_media(false);
    let session = webkit::NetworkSession::new_ephemeral();
    session.connect_download_started(|_, download| download.cancel());
    let web = webkit::WebView::builder()
        .network_session(&session)
        .user_content_manager(&webkit::UserContentManager::new())
        .settings(&settings)
        .hexpand(true)
        .vexpand(true)
        .build();
    // No white flash in dark mode before the page draws.
    web.set_background_color(&gdk::RGBA::TRANSPARENT);
    web.connect_permission_request(|_, request| {
        request.deny();
        true
    });
    web.connect_context_menu(|_, menu, _| {
        use webkit::ContextMenuAction as A;
        for item in menu.items() {
            // Each would load a page in the view or save one.
            if matches!(
                item.stock_action(),
                A::OpenLink
                    | A::OpenLinkInNewWindow
                    | A::DownloadLinkToDisk
                    | A::OpenImageInNewWindow
                    | A::DownloadImageToDisk
                    | A::OpenFrameInNewWindow
                    | A::OpenVideoInNewWindow
                    | A::OpenAudioInNewWindow
                    | A::DownloadVideoToDisk
                    | A::DownloadAudioToDisk
                    | A::GoBack
                    | A::GoForward
                    | A::Stop
                    | A::Reload
            ) {
                menu.remove(&item);
            }
        }
        let items = menu.items();
        for item in [items.first(), items.last()].into_iter().flatten() {
            if item.is_separator() {
                menu.remove(item);
            }
        }
        menu.items().iter().all(|i| i.is_separator())
    });
    web
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
