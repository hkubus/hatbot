// It streams only while it's on screen.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use adw::prelude::*;
use gtk::{gdk, gio, glib};
use hatbot::core::format;
use hatbot::core::links::Link;
use hatbot::core::models::{Control, StepKind, latest_note_only};
use hatbot::net::live::Live;
use hatbot::store::{Change, Listener, Store};

use super::icon::Icon;
use super::route;

/// Until the first frame says otherwise: the desktop's usual size.
const DEFAULT_SIZE: (f64, f64) = (1280.0, 800.0);

pub struct LiveView {
    pub root: gtk::Box,
    _inner: Rc<Inner>,
    _listener: Listener,
}

struct Inner {
    store: Store,
    live: Live,
    /// The task it's for; without one, the task using the desktop.
    task_id: Option<i64>,
    shows_task: bool,
    banner: gtk::Box,
    banner_text: gtk::Label,
    banner_button: gtk::Button,
    take_over: gtk::Button,
    error: gtk::Label,
    frame: gtk::AspectFrame,
    screen: gtk::Overlay,
    picture: gtk::Picture,
    status: gtk::Label,
    task: gtk::Box,
    task_shown: RefCell<String>,
    /// The task whose steps were asked for, so they're asked for once.
    task_loaded: Cell<Option<i64>>,
    connected: Cell<bool>,
    in_control: Cell<bool>,
    size: Cell<(f64, f64)>,
    /// Frames come faster than a slow machine decodes them: only the newest waiting one is drawn.
    decoding: Cell<bool>,
    next: RefCell<Option<glib::Bytes>>,
    busy: Cell<bool>,
}

impl LiveView {
    pub fn new(store: &Store, task_id: Option<i64>, shows_task: bool) -> LiveView {
        let banner_text = gtk::Label::builder()
            .use_markup(true)
            .wrap(true)
            .xalign(0.0)
            .hexpand(true)
            .build();
        let banner_button = gtk::Button::builder()
            .valign(gtk::Align::Center)
            .css_classes(["pill", "attention"])
            .build();
        let hand = Icon::new("hand", 18);
        hand.add_css_class("needs-you");
        let banner = gtk::Box::builder()
            .spacing(10)
            .visible(false)
            .css_classes(["card", "live-banner"])
            .build();
        banner.append(&hand);
        banner.append(&banner_text);
        banner.append(&banner_button);

        let picture = gtk::Picture::builder()
            .content_fit(gtk::ContentFit::Fill)
            .can_shrink(true)
            .paintable(&placeholder())
            .build();
        let status = gtk::Label::builder()
            .halign(gtk::Align::Center)
            .valign(gtk::Align::Center)
            .can_target(false)
            .wrap(true)
            .css_classes(["live-status"])
            .build();
        let screen = gtk::Overlay::builder()
            .child(&picture)
            .overflow(gtk::Overflow::Hidden)
            .css_classes(["live-screen"])
            .tooltip_text("The desktop")
            .build();
        screen.add_overlay(&status);
        let frame = gtk::AspectFrame::builder()
            .ratio((DEFAULT_SIZE.0 / DEFAULT_SIZE.1) as f32)
            .obey_child(false)
            .vexpand(true)
            .child(&screen)
            .build();

        let take_over = gtk::Button::builder()
            .halign(gtk::Align::Start)
            .visible(false)
            .label("Take Over")
            .css_classes(["pill"])
            .build();
        let error = gtk::Label::builder()
            .visible(false)
            .wrap(true)
            .xalign(0.0)
            .css_classes(["error"])
            .build();
        let task = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(8)
            .visible(false)
            .css_classes(["card", "task-head"])
            .build();
        let root = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(12)
            .build();
        for w in [
            banner.upcast_ref::<gtk::Widget>(),
            frame.upcast_ref(),
            take_over.upcast_ref(),
            error.upcast_ref(),
            task.upcast_ref(),
        ] {
            root.append(w);
        }

        let inner = Rc::new(Inner {
            store: store.clone(),
            live: Live::new(store.api()),
            task_id,
            shows_task,
            banner,
            banner_text,
            banner_button,
            take_over,
            error,
            frame,
            screen,
            picture,
            status,
            task,
            task_shown: RefCell::default(),
            task_loaded: Cell::new(None),
            connected: Cell::new(false),
            in_control: Cell::new(false),
            size: Cell::new(DEFAULT_SIZE),
            decoding: Cell::new(false),
            next: RefCell::default(),
            busy: Cell::new(false),
        });
        inner.connect();
        inner.add_input();
        let weak = Rc::downgrade(&inner);
        let listener = store.listen(move |change| {
            let Some(i) = weak.upgrade() else { return };
            match change {
                Change::Desktop | Change::NeedsYou => i.render(),
                Change::Task(_) => i.render_task(),
                _ => {}
            }
        });
        inner.render();
        LiveView {
            root,
            _inner: inner,
            _listener: listener,
        }
    }
}

impl Inner {
    fn connect(self: &Rc<Self>) {
        let weak = Rc::downgrade(self);
        self.live.on_frame(move |bytes| {
            if let Some(i) = weak.upgrade() {
                i.show_frame(bytes);
            }
        });
        let weak = Rc::downgrade(self);
        self.live.on_connected(move |connected| {
            if let Some(i) = weak.upgrade() {
                i.connected.set(connected);
                i.render();
            }
        });
        let weak = Rc::downgrade(self);
        self.screen.connect_map(move |_| {
            if let Some(i) = weak.upgrade() {
                i.live.start();
            }
        });
        let weak = Rc::downgrade(self);
        self.screen.connect_unmap(move |_| {
            if let Some(i) = weak.upgrade() {
                i.live.stop();
                i.connected.set(false);
                i.render();
            }
        });
        for button in [&self.banner_button, &self.take_over] {
            let weak = Rc::downgrade(self);
            button.connect_clicked(move |_| {
                if let Some(i) = weak.upgrade() {
                    i.toggle_control();
                }
            });
        }
    }

    fn show_frame(self: &Rc<Self>, bytes: glib::Bytes) {
        if self.decoding.replace(true) {
            self.next.replace(Some(bytes));
            return;
        }
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            let decoded = gio::spawn_blocking(move || gdk::Texture::from_bytes(&bytes)).await;
            let Some(i) = weak.upgrade() else { return };
            if let Ok(Ok(texture)) = decoded {
                let size = (texture.width() as f64, texture.height() as f64);
                if size != i.size.get() {
                    i.size.set(size);
                    i.frame.set_ratio((size.0 / size.1) as f32);
                }
                if i.online() {
                    i.picture.set_paintable(Some(&texture));
                }
            }
            i.decoding.set(false);
            if let Some(next) = i.next.take() {
                i.show_frame(next);
            }
        });
    }

    fn online(&self) -> bool {
        self.store.state().desktop.as_ref().is_none_or(|d| d.online)
    }

    /// A point on the screen widget in the desktop's pixels.
    fn to_desktop(&self, x: f64, y: f64) -> (f64, f64) {
        let (w, h) = (self.screen.width() as f64, self.screen.height() as f64);
        let (dw, dh) = self.size.get();
        if w <= 0.0 || h <= 0.0 {
            return (0.0, 0.0);
        }
        (x / w * dw, y / h * dh)
    }

    fn add_input(self: &Rc<Self>) {
        let motion = gtk::EventControllerMotion::new();
        let pointer = Rc::new(Cell::new((0.0, 0.0)));
        for signal in ["enter", "motion"] {
            let (weak, pointer) = (Rc::downgrade(self), pointer.clone());
            motion.connect_closure(
                signal,
                false,
                glib::closure_local!(move |_: gtk::EventControllerMotion, x: f64, y: f64| {
                    pointer.set((x, y));
                    if let Some(i) = weak.upgrade()
                        && i.in_control.get()
                    {
                        let (x, y) = i.to_desktop(x, y);
                        i.live.pointer_move(x, y);
                    }
                }),
            );
        }
        self.screen.add_controller(motion);

        // Presses and releases as they are: a click gesture would hold back or drop the ones a drag
        // or a double click makes.
        let buttons = gtk::EventControllerLegacy::new();
        let (weak, at) = (Rc::downgrade(self), pointer.clone());
        buttons.connect_event(move |_, event| {
            let Some(i) = weak.upgrade() else {
                return glib::Propagation::Proceed;
            };
            let down = match event.event_type() {
                gdk::EventType::ButtonPress => true,
                gdk::EventType::ButtonRelease => false,
                _ => return glib::Propagation::Proceed,
            };
            let Some(button) = event.downcast_ref::<gdk::ButtonEvent>().map(|e| e.button()) else {
                return glib::Propagation::Proceed;
            };
            if !i.in_control.get() || !(1..=3).contains(&button) {
                return glib::Propagation::Proceed;
            }
            if down {
                i.screen.grab_focus();
            }
            let (x, y) = at.get();
            let (x, y) = i.to_desktop(x, y);
            i.live.button(button as u8, down, x, y);
            glib::Propagation::Stop
        });
        self.screen.add_controller(buttons);

        let scroll = gtk::EventControllerScroll::new(gtk::EventControllerScrollFlags::BOTH_AXES);
        let weak = Rc::downgrade(self);
        scroll.connect_scroll(move |c, dx, dy| {
            let Some(i) = weak.upgrade().filter(|i| i.in_control.get()) else {
                return glib::Propagation::Proceed;
            };
            // The desktop counts 50 as a notch, as browsers give pixels.
            let per = if c.unit() == gdk::ScrollUnit::Wheel {
                50.0
            } else {
                1.0
            };
            let (x, y) = pointer.get();
            let (x, y) = i.to_desktop(x, y);
            i.live.wheel(dx * per, dy * per, x, y);
            glib::Propagation::Stop
        });
        self.screen.add_controller(scroll);

        let keys = gtk::EventControllerKey::new();
        let weak = Rc::downgrade(self);
        keys.connect_key_pressed(move |_, key, _, _| {
            match (weak.upgrade().filter(|i| i.in_control.get()), key_name(key)) {
                (Some(i), Some(name)) => {
                    i.live.key(&name, true);
                    glib::Propagation::Stop
                }
                _ => glib::Propagation::Proceed,
            }
        });
        let weak = Rc::downgrade(self);
        keys.connect_key_released(move |_, key, _, _| {
            if let (Some(i), Some(name)) = (weak.upgrade(), key_name(key)) {
                i.live.key(&name, false);
            }
        });
        self.screen.add_controller(keys);

        let focus = gtk::EventControllerFocus::new();
        let weak = Rc::downgrade(self);
        focus.connect_leave(move |_| {
            if let Some(i) = weak.upgrade() {
                i.live.release_all();
            }
        });
        self.screen.add_controller(focus);
    }

    fn toggle_control(self: &Rc<Self>) {
        if self.busy.replace(true) {
            return;
        }
        let hand_back = self.in_control.get();
        if hand_back {
            self.live.release_all();
        }
        let weak = Rc::downgrade(self);
        let store = self.store.clone();
        glib::spawn_future_local(async move {
            let result = if hand_back {
                store.hand_back().await
            } else {
                store.take_over().await
            };
            let Some(i) = weak.upgrade() else { return };
            i.busy.set(false);
            match result {
                Ok(()) => i.error.set_visible(false),
                Err(e) => {
                    i.error.set_label(&e.message);
                    i.error.set_visible(true);
                }
            }
        });
    }

    fn render(&self) {
        let (in_control, request, online) = {
            let st = self.store.state();
            let d = st.desktop.as_ref();
            (
                d.is_some_and(|d| d.control == Control::Owner),
                d.and_then(|d| d.request.clone()),
                d.is_none_or(|d| d.online),
            )
        };
        if self.in_control.replace(in_control) && !in_control {
            self.live.release_all();
        }
        self.screen.set_focusable(in_control);
        if in_control {
            self.screen.add_css_class("in-control");
            if !self.screen.has_focus() && self.screen.is_mapped() {
                self.screen.grab_focus();
            }
        } else {
            self.screen.remove_css_class("in-control");
        }

        if in_control {
            self.banner_text
                .set_label("You're in control. Hatbot is paused.");
            self.banner_button.set_label("Hand Back");
        } else if let Some(r) = &request {
            self.banner_text.set_label(&format!(
                "<b>Hatbot needs you:</b> {}",
                glib::markup_escape_text(&r.reason)
            ));
            self.banner_button.set_label("Take Over");
        }
        self.banner.set_visible(in_control || request.is_some());
        self.take_over
            .set_visible(!in_control && request.is_none() && online);

        if !online {
            self.picture.set_paintable(Some(&placeholder()));
        }
        let status = if !online {
            Some("The desktop isn't answering.")
        } else if !self.connected.get() {
            Some("Connecting…")
        } else {
            None
        };
        self.status.set_label(status.unwrap_or(""));
        self.status.set_visible(status.is_some());
        self.render_task();
    }

    fn render_task(&self) {
        let st = self.store.state();
        let id = self.task_id.or_else(|| {
            let d = st.desktop.as_ref()?;
            d.active_task_id.or(d.request.as_ref().map(|r| r.task_id))
        });
        let Some(id) = id.filter(|_| self.shows_task) else {
            self.task.set_visible(false);
            return;
        };
        if self.task_loaded.replace(Some(id)) != Some(id) {
            let store = self.store.clone();
            glib::spawn_future_local(async move {
                let _ = store.load_task(id).await;
            });
        }
        let (Some(t), Some(steps)) = (st.tasks.get(&id), st.steps.get(&id)) else {
            self.task.set_visible(false);
            return;
        };
        let line = format::task_line(t, st.task_progress.get(&id).map(String::as_str));
        let recent: Vec<_> = latest_note_only(steps).into_iter().rev().take(6).collect();
        let key = format!(
            "{id}\u{1}{}\u{1}{line}\u{1}{}",
            t.title,
            recent
                .iter()
                .map(|s| s.id.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
        self.task.set_visible(true);
        if *self.task_shown.borrow() == key {
            return;
        }
        self.task_shown.replace(key);
        while let Some(c) = self.task.first_child() {
            self.task.remove(&c);
        }
        let title = gtk::Box::builder().spacing(6).build();
        title.append(
            &gtk::Label::builder()
                .label(&t.title)
                .xalign(0.0)
                .hexpand(true)
                .wrap(true)
                .css_classes(["heading"])
                .build(),
        );
        title.append(&gtk::Image::from_icon_name("go-next-symbolic"));
        let open = gtk::Button::builder()
            .child(&title)
            .css_classes(["flat", "live-task"])
            .tooltip_text("Open Task")
            .build();
        open.connect_clicked(move |_| route::go(Link::Task(id)));
        self.task.append(&open);
        self.task.append(
            &gtk::Label::builder()
                .label(&line)
                .xalign(0.0)
                .wrap(true)
                .css_classes(["dim-label"])
                .build(),
        );
        for s in recent {
            let row = gtk::Box::builder().spacing(10).build();
            row.append(
                &gtk::Label::builder()
                    .label(format::time_text(&s.created_at))
                    .valign(gtk::Align::Start)
                    .css_classes(["caption", "dim-label", "numeric"])
                    .build(),
            );
            let text = gtk::Label::builder()
                .label(if s.detail.is_empty() {
                    &s.name
                } else {
                    &s.detail
                })
                .xalign(0.0)
                .hexpand(true)
                .wrap(true)
                .lines(2)
                .ellipsize(gtk::pango::EllipsizeMode::End)
                .build();
            if matches!(s.kind, StepKind::Approval | StepKind::Takeover) {
                text.add_css_class("needs-you");
            }
            row.append(&text);
            self.task.append(&row);
        }
    }
}

/// Black at the desktop's usual shape, before a frame or while it's away.
fn placeholder() -> gdk::Paintable {
    gdk::Paintable::new_empty(DEFAULT_SIZE.0 as i32, DEFAULT_SIZE.1 as i32)
}

/// A key as the desktop takes it: what it types, or its X name (`Return`, `Control_L`, `F5`).
fn key_name(key: gdk::Key) -> Option<String> {
    match key.to_unicode() {
        Some(c) if !c.is_control() => Some(c.to_string()),
        _ => key.name().map(|n| n.to_string()),
    }
}
