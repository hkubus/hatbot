// Above the composer: the oldest approval waiting for you, from any chat, then the oldest question;
// the next shows once you've answered it.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use hatbot::core::markdown::escape;
use hatbot::core::models::{Approval, ApprovalKind, Question};
use hatbot::store::Store;

use hatbot::core::links::Link;

use super::files::{Thumb, zoom_on_click};
use super::markdown::{Markdown, label};
use super::route;

pub struct Tray {
    pub root: gtk::Box,
    store: Store,
    /// What's showing: "a1" or "q2", so news about others leaves your note alone.
    shown: RefCell<String>,
}

impl Tray {
    pub fn new(store: &Store) -> Rc<Tray> {
        let root = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(10)
            .visible(false)
            .css_classes(["card", "tray"])
            .build();
        let tray = Rc::new(Tray {
            root,
            store: store.clone(),
            shown: RefCell::default(),
        });
        tray.sync();
        tray
    }

    pub fn sync(&self) {
        let (key, approval, question, waiting) = {
            let st = self.store.state();
            let a = st.pending_approvals().first().map(|a| (*a).clone());
            let q = st.pending_questions().first().map(|q| (*q).clone());
            let waiting = st.pending_approvals().len() + st.pending_questions().len();
            let key = match (&a, &q) {
                (Some(a), _) => format!("a{}:{waiting}", a.id),
                (None, Some(q)) => format!("q{}:{waiting}", q.id),
                _ => String::new(),
            };
            (key, a, q, waiting)
        };
        if *self.shown.borrow() == key {
            return;
        }
        // Only the count changed: keep what you've written.
        let same = self.shown.borrow().split(':').next() == key.split(':').next();
        self.shown.replace(key);
        if same
            && let Some(more) = self.root.last_child().and_downcast::<gtk::Label>()
            && more.has_css_class("more")
        {
            more.set_label(&format!("{} more waiting", waiting - 1));
            more.set_visible(waiting > 1);
            return;
        }
        while let Some(c) = self.root.first_child() {
            self.root.remove(&c);
        }
        self.root.set_visible(waiting > 0);
        if let Some(a) = approval {
            self.root.append(&approval_body(&self.store, &a, true));
        } else if let Some(q) = question {
            self.root.append(&question_body(&self.store, &q, true));
        }
        let more = gtk::Label::builder()
            .label(format!("{} more waiting", waiting.saturating_sub(1)))
            .xalign(0.0)
            .visible(waiting > 1)
            .css_classes(["caption", "dim-label", "more"])
            .build();
        self.root.append(&more);
    }
}

fn error_label() -> gtk::Label {
    gtk::Label::builder()
        .xalign(0.0)
        .wrap(true)
        .visible(false)
        .css_classes(["caption", "error"])
        .build()
}

/// "Open Task", in the chat, where the task isn't on the screen.
fn open_task(id: i64) -> gtk::Button {
    let b = gtk::Button::builder()
        .label("Open Task")
        .halign(gtk::Align::Start)
        .css_classes(["flat"])
        .build();
    b.connect_clicked(move |_| route::go(Link::Task(id)));
    b
}

/// What it wants to do and why, the pages it read, a screenshot, then Deny and Approve.
pub fn approval_body(store: &Store, a: &Approval, links_task: bool) -> gtk::Box {
    let root = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(10)
        .build();
    // The summary can be a whole shell command: shown as written.
    root.append(&label(&format!(
        "<b>Can I go ahead?</b> {}",
        escape(&a.summary)
    )));
    let mut text = a.reason.clone();
    if !a.sources.is_empty() {
        let after = format!("_After reading {}_", a.sources.join(", "));
        text = if text.is_empty() {
            after
        } else {
            format!("{text}\n\n{after}")
        };
    }
    if !text.is_empty() {
        root.append(&Markdown::new(&text).root);
    }
    if let (Some(task), Some(step)) = (a.task_id, a.screenshot_step_id) {
        let thumb = Thumb::new(320);
        thumb.set_halign(gtk::Align::Start);
        thumb.load(store, format!("/tasks/{task}/screens/{step}"));
        zoom_on_click(&thumb, "Screenshot");
        root.append(&thumb);
    }
    let takes_note = !matches!(
        a.kind,
        ApprovalKind::Budget | ApprovalKind::InjectionWarning
    );
    let note = gtk::Entry::builder()
        .placeholder_text("Tell it what to do instead, or how to go ahead")
        .visible(takes_note)
        .build();
    root.append(&note);
    if links_task && let Some(id) = a.task_id {
        root.append(&open_task(id));
    }
    let error = error_label();
    root.append(&error);
    let buttons = gtk::Box::builder().spacing(16).homogeneous(true).build();
    let deny = gtk::Button::builder()
        .label("Deny")
        .css_classes(["pill", "destructive-action"])
        .build();
    let approve = gtk::Button::builder()
        .label("Approve")
        .css_classes(["pill", "attention"])
        .build();
    buttons.append(&deny);
    buttons.append(&approve);
    root.append(&buttons);
    let busy = Rc::new(Cell::new(false));
    for (b, yes) in [(&deny, false), (&approve, true)] {
        let (store, busy, id) = (store.clone(), busy.clone(), a.id);
        let (note, error, buttons) = (note.downgrade(), error.downgrade(), buttons.downgrade());
        b.connect_clicked(move |_| {
            if busy.replace(true) {
                return;
            }
            let text = note
                .upgrade()
                .map(|n| n.text().to_string())
                .unwrap_or_default();
            if let Some(b) = buttons.upgrade() {
                b.set_sensitive(false);
            }
            let (store, busy, error, buttons) =
                (store.clone(), busy.clone(), error.clone(), buttons.clone());
            glib::spawn_future_local(async move {
                let Err(e) = store.decide(id, yes, &text).await else {
                    return;
                };
                busy.set(false);
                if let (Some(l), Some(b)) = (error.upgrade(), buttons.upgrade()) {
                    l.set_label(&e.message);
                    l.set_visible(true);
                    b.set_sensitive(true);
                }
            });
        });
    }
    root
}

/// A task's question: click an answer, or write your own.
pub fn question_body(store: &Store, q: &Question, links_task: bool) -> gtk::Box {
    let root = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(10)
        .build();
    root.append(&label(&format!("<b>{}</b>", escape(&q.question))));
    if !q.sources.is_empty() {
        let l = label(&escape(&format!("After reading {}", q.sources.join(", "))));
        l.add_css_class("caption");
        l.add_css_class("dim-label");
        root.append(&l);
    }
    let error = error_label();
    let answers = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(6)
        .build();
    let answer = {
        let (store, busy, id) = (store.clone(), Rc::new(Cell::new(false)), q.id);
        let (error, answers) = (error.downgrade(), answers.downgrade());
        move |text: String| {
            let text = text.trim().to_string();
            if text.is_empty() || busy.replace(true) {
                return;
            }
            if let Some(a) = answers.upgrade() {
                a.set_sensitive(false);
            }
            let (store, busy, error, answers) =
                (store.clone(), busy.clone(), error.clone(), answers.clone());
            glib::spawn_future_local(async move {
                let Err(e) = store.answer(id, &text).await else {
                    return;
                };
                busy.set(false);
                if let (Some(l), Some(a)) = (error.upgrade(), answers.upgrade()) {
                    l.set_label(&e.message);
                    l.set_visible(true);
                    a.set_sensitive(true);
                }
            });
        }
    };
    for c in &q.choices {
        let b = gtk::Button::builder()
            .label(c)
            .css_classes(["pill", "suggested-action"])
            .build();
        let (answer, c) = (answer.clone(), c.clone());
        b.connect_clicked(move |_| answer(c.clone()));
        answers.append(&b);
    }
    let own = gtk::Entry::builder()
        .placeholder_text(if q.choices.is_empty() {
            "Your answer"
        } else {
            "Or write your own"
        })
        .hexpand(true)
        .build();
    let send = gtk::Button::builder()
        .label("Send")
        .sensitive(false)
        .build();
    let s = send.downgrade();
    own.connect_changed(move |e| {
        if let Some(s) = s.upgrade() {
            s.set_sensitive(!e.text().trim().is_empty());
        }
    });
    let a = answer.clone();
    own.connect_activate(move |e| a(e.text().to_string()));
    let e = own.downgrade();
    send.connect_clicked(move |_| {
        if let Some(e) = e.upgrade() {
            answer(e.text().to_string());
        }
    });
    let line = gtk::Box::builder().spacing(8).build();
    line.append(&own);
    line.append(&send);
    answers.append(&line);
    root.append(&answers);
    if links_task {
        root.append(&open_task(q.task_id));
    }
    root.append(&error);
    root
}
