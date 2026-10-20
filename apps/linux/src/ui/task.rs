// A task's page: what waits on you for it, how it's doing or how it ended, its details, and the
// timeline of what it did, with Cancel while it runs and Run Again once it's ended.
use std::cell::RefCell;
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use hatbot::core::format;
use hatbot::core::links::Link;
use hatbot::core::markdown::escape;
use hatbot::core::models::{StepKind, Task, TaskStatus, TaskStep, latest_note_only};
use hatbot::store::{Change, Listener, Store};

use super::files::{Thumb, is_markdown, read, zoom_on_click};
use super::icon::Icon;
use super::markdown::{Markdown, label};
use super::route;
use super::tray::{approval_body, question_body};

/// "Running", "Needs approval", "Done", in its colour.
pub fn status_label(s: TaskStatus) -> gtk::Label {
    let colour = match s {
        TaskStatus::WaitingApproval | TaskStatus::WaitingTakeover | TaskStatus::WaitingAnswer => {
            "needs-you"
        }
        TaskStatus::Running | TaskStatus::Unknown => "accent",
        TaskStatus::Done => "success",
        TaskStatus::Failed => "error",
        TaskStatus::Queued | TaskStatus::Cancelled => "dim-label",
    };
    gtk::Label::builder()
        .label(format::status_label(s))
        .xalign(0.0)
        .css_classes(["status", colour])
        .build()
}

pub struct TaskPage {
    pub page: adw::NavigationPage,
    _inner: Rc<Inner>,
    _listener: Listener,
}

struct Inner {
    store: Store,
    id: i64,
    page: adw::NavigationPage,
    stack: gtk::Stack,
    error: gtk::Label,
    asks: gtk::Box,
    asks_shown: RefCell<String>,
    title: gtk::Label,
    status: gtk::Box,
    line: gtk::Label,
    summary: Markdown,
    details: gtk::Expander,
    details_shown: RefCell<Option<Task>>,
    timeline: gtk::Box,
    steps_shown: RefCell<Vec<(TaskStep, gtk::Widget)>>,
    no_steps: gtk::Label,
    cancel: gtk::Button,
    rerun: gtk::Button,
}

impl TaskPage {
    pub fn new(store: &Store, id: i64) -> TaskPage {
        let cancel = gtk::Button::builder()
            .icon_name("process-stop-symbolic")
            .tooltip_text("Cancel Task")
            .visible(false)
            .build();
        let rerun = gtk::Button::builder()
            .icon_name("view-refresh-symbolic")
            .tooltip_text("Run Again")
            .visible(false)
            .build();
        let header = adw::HeaderBar::new();
        header.pack_end(&cancel);
        header.pack_end(&rerun);

        let error = gtk::Label::builder()
            .visible(false)
            .wrap(true)
            .xalign(0.0)
            .css_classes(["error"])
            .build();
        let asks = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(12)
            .build();
        let title = gtk::Label::builder()
            .xalign(0.0)
            .wrap(true)
            .selectable(true)
            .css_classes(["title-3"])
            .build();
        let status = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        let line = gtk::Label::builder()
            .xalign(0.0)
            .wrap(true)
            .css_classes(["dim-label"])
            .build();
        let summary = Markdown::new("");
        let details = gtk::Expander::builder().label("Details").build();
        let head = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(8)
            .css_classes(["card", "task-head"])
            .build();
        for w in [
            title.upcast_ref::<gtk::Widget>(),
            status.upcast_ref(),
            line.upcast_ref(),
            summary.root.upcast_ref(),
            details.upcast_ref(),
        ] {
            head.append(w);
        }
        let timeline = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(14)
            .build();
        let no_steps = gtk::Label::builder()
            .xalign(0.0)
            .css_classes(["dim-label"])
            .build();
        let column = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(12)
            .margin_top(12)
            .margin_bottom(24)
            .margin_start(12)
            .margin_end(12)
            .build();
        column.append(&error);
        column.append(&asks);
        column.append(&head);
        column.append(
            &gtk::Label::builder()
                .label("Timeline")
                .xalign(0.0)
                .margin_top(8)
                .css_classes(["heading"])
                .build(),
        );
        column.append(&no_steps);
        column.append(&timeline);
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
        let gone = adw::StatusPage::builder()
            .icon_name("dialog-question-symbolic")
            .title("This task doesn't exist.")
            .build();
        let stack = gtk::Stack::new();
        stack.add_named(&adw::Spinner::new(), Some("loading"));
        stack.add_named(&gone, Some("gone"));
        stack.add_named(&scroll, Some("task"));
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        view.set_content(Some(&stack));
        let page = adw::NavigationPage::builder()
            .title("Task")
            .child(&view)
            .build();

        let inner = Rc::new(Inner {
            store: store.clone(),
            id,
            page: page.clone(),
            stack,
            error,
            asks,
            asks_shown: RefCell::default(),
            title,
            status,
            line,
            summary,
            details,
            details_shown: RefCell::default(),
            timeline,
            steps_shown: RefCell::default(),
            no_steps,
            cancel,
            rerun,
        });
        let weak = Rc::downgrade(&inner);
        inner.cancel.connect_clicked(move |b| {
            if let Some(i) = weak.upgrade() {
                i.ask_cancel(b);
            }
        });
        let weak = Rc::downgrade(&inner);
        inner.rerun.connect_clicked(move |b| {
            if let Some(i) = weak.upgrade() {
                i.ask_rerun(b);
            }
        });
        let weak = Rc::downgrade(&inner);
        let listener = store.listen(move |change| {
            let Some(i) = weak.upgrade() else { return };
            match change {
                Change::Task(t) if *t == i.id => i.render(),
                Change::NeedsYou => i.render(),
                _ => {}
            }
        });
        inner.render();
        let weak = Rc::downgrade(&inner);
        glib::spawn_future_local(async move {
            let Some(store) = weak.upgrade().map(|i| i.store.clone()) else {
                return;
            };
            let result = store.load_task(id).await;
            let (Some(i), Err(e)) = (weak.upgrade(), result) else {
                return;
            };
            if e.status == 404 {
                i.stack.set_visible_child_name("gone");
            } else {
                i.show_error(&e.message);
                i.stack.set_visible_child_name("task");
            }
        });
        TaskPage {
            page,
            _inner: inner,
            _listener: listener,
        }
    }
}

impl Inner {
    fn show_error(&self, text: &str) {
        self.error.set_label(text);
        self.error.set_visible(true);
    }

    fn render(&self) {
        let st = self.store.state();
        let (Some(t), Some(steps)) = (st.tasks.get(&self.id), st.steps.get(&self.id)) else {
            return;
        };
        self.stack.set_visible_child_name("task");
        self.page.set_title(&t.title);

        let approvals: Vec<_> = st
            .pending_approvals()
            .into_iter()
            .filter(|a| a.task_id == Some(self.id))
            .collect();
        let questions: Vec<_> = st
            .pending_questions()
            .into_iter()
            .filter(|q| q.task_id == self.id)
            .collect();
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
            for body in approvals
                .iter()
                .map(|a| approval_body(&self.store, a, false))
                .chain(
                    questions
                        .iter()
                        .map(|q| question_body(&self.store, q, false)),
                )
            {
                body.add_css_class("card");
                body.add_css_class("tray");
                self.asks.append(&body);
            }
        }

        let active = t.status.is_active();
        self.title.set_label(&t.title);
        if let Some(c) = self.status.first_child() {
            self.status.remove(&c);
        }
        self.status.append(&status_label(t.status));
        let summary = t.summary.as_deref().filter(|_| !active);
        self.line.set_label(&format::task_line(
            t,
            st.task_progress.get(&self.id).map(String::as_str),
        ));
        self.line.set_visible(active);
        self.summary.set(summary.unwrap_or(""));
        self.summary.root.set_visible(summary.is_some());
        if self.details_shown.borrow().as_ref() != Some(t) {
            self.details_shown.replace(Some(t.clone()));
            let files = st.task_files.get(&self.id).cloned().unwrap_or_default();
            self.details
                .set_child(Some(&details(&self.store, t, &files)));
        }
        self.cancel.set_visible(active);
        // As the brain allows: an ended background task that no other task started.
        self.rerun
            .set_visible(!active && t.lane == "background" && t.parent_id.is_none());

        let steps: Vec<TaskStep> = latest_note_only(steps).into_iter().cloned().collect();
        self.no_steps.set_label(if active {
            "Hasn't started yet."
        } else {
            "No steps."
        });
        self.no_steps.set_visible(steps.is_empty());
        // Steps only come at the end; a screenshot can be added to one later.
        let mut shown = self.steps_shown.borrow_mut();
        let same = shown
            .iter()
            .zip(&steps)
            .take_while(|((a, _), b)| a == *b)
            .count();
        for (_, w) in shown.drain(same..) {
            self.timeline.remove(&w);
        }
        for s in steps.into_iter().skip(same) {
            let w = step_row(&self.store, &s);
            self.timeline.append(&w);
            shown.push((s, w));
        }
    }

    fn ask_cancel(self: &Rc<Self>, from: &gtk::Button) {
        let title = self
            .store
            .state()
            .tasks
            .get(&self.id)
            .map(|t| t.title.clone());
        let dialog = adw::AlertDialog::new(
            Some(&format!("Cancel “{}”?", title.unwrap_or_default())),
            None,
        );
        dialog.add_responses(&[("keep", "Keep Running"), ("cancel", "Cancel Task")]);
        dialog.set_response_appearance("cancel", adw::ResponseAppearance::Destructive);
        dialog.set_close_response("keep");
        let weak = Rc::downgrade(self);
        dialog.connect_response(Some("cancel"), move |_, _| {
            let weak = weak.clone();
            glib::spawn_future_local(async move {
                let Some(store) = weak.upgrade().map(|i| i.store.clone()) else {
                    return;
                };
                let id = weak.upgrade().map_or(0, |i| i.id);
                if let (Err(e), Some(i)) = (store.cancel_task(id).await, weak.upgrade()) {
                    i.show_error(&e.message);
                }
            });
        });
        dialog.present(Some(from));
    }

    /// Asks for the goal, as it was or changed, then opens the new task.
    fn ask_rerun(self: &Rc<Self>, from: &gtk::Button) {
        let goal = self
            .store
            .state()
            .tasks
            .get(&self.id)
            .map(|t| t.goal.clone())
            .unwrap_or_default();
        let field = gtk::TextView::builder()
            .wrap_mode(gtk::WrapMode::WordChar)
            .top_margin(9)
            .bottom_margin(9)
            .left_margin(12)
            .right_margin(12)
            .build();
        field.buffer().set_text(&goal);
        field.update_property(&[gtk::accessible::Property::Label("Goal")]);
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .min_content_height(120)
            .max_content_height(360)
            .propagate_natural_height(true)
            .child(&field)
            .css_classes(["card"])
            .build();
        let error = gtk::Label::builder()
            .visible(false)
            .wrap(true)
            .xalign(0.0)
            .css_classes(["error"])
            .build();
        let column = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(12)
            .margin_top(12)
            .margin_bottom(18)
            .margin_start(18)
            .margin_end(18)
            .build();
        column.append(
            &gtk::Label::builder()
                .label("Goal")
                .xalign(0.0)
                .css_classes(["heading"])
                .build(),
        );
        column.append(&scroll);
        column.append(&error);
        let run = gtk::Button::builder()
            .label("Run")
            .css_classes(["suggested-action"])
            .build();
        let header = adw::HeaderBar::new();
        header.pack_end(&run);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        view.set_content(Some(&column));
        let dialog = adw::Dialog::builder()
            .title("Run Again")
            .content_width(520)
            .child(&view)
            .build();
        let r = run.downgrade();
        field.buffer().connect_changed(move |b| {
            if let Some(r) = r.upgrade() {
                let text = b.text(&b.start_iter(), &b.end_iter(), false);
                r.set_sensitive(!text.trim().is_empty());
            }
        });
        let (weak, d) = (Rc::downgrade(self), dialog.downgrade());
        run.connect_clicked(move |run| {
            let b = field.buffer();
            let text = b
                .text(&b.start_iter(), &b.end_iter(), false)
                .trim()
                .to_string();
            // Unchanged, it's left out, as iOS does.
            let changed = (text != goal.trim()).then_some(text);
            run.set_sensitive(false);
            let (weak, d, run, error) =
                (weak.clone(), d.clone(), run.downgrade(), error.downgrade());
            glib::spawn_future_local(async move {
                let Some(i) = weak.upgrade() else { return };
                match i.store.rerun_task(i.id, changed.as_deref()).await {
                    Ok(t) => {
                        if let Some(d) = d.upgrade() {
                            d.close();
                        }
                        route::go(Link::Task(t.id));
                    }
                    Err(e) => {
                        if let (Some(l), Some(r)) = (error.upgrade(), run.upgrade()) {
                            l.set_label(&e.message);
                            l.set_visible(true);
                            r.set_sensitive(true);
                        }
                    }
                }
            });
        });
        dialog.present(Some(from));
    }
}

/// Where it came from, the goal, the model, whether it read untrusted content, what it cost, and its
/// report.
fn details(store: &Store, t: &Task, files: &[hatbot::core::models::Attachment]) -> gtk::Grid {
    let grid = gtk::Grid::builder()
        .column_spacing(16)
        .row_spacing(8)
        .margin_top(10)
        .build();
    let mut row = 0;
    let mut add = |name: &str, value: gtk::Widget| {
        grid.attach(
            &gtk::Label::builder()
                .label(name)
                .xalign(0.0)
                .yalign(0.0)
                .css_classes(["dim-label"])
                .build(),
            0,
            row,
            1,
            1,
        );
        value.set_hexpand(true);
        grid.attach(&value, 1, row, 1, 1);
        row += 1;
    };
    let text = |s: &str| label(&escape(s)).upcast::<gtk::Widget>();
    let from = if let Some(parent) = t.parent_id {
        label(&format!(
            "<a href=\"hatbot://tasks/{parent}\">Task #{parent}</a>"
        ))
        .upcast()
    } else if t.origin == "chat" {
        text("Chat")
    } else {
        text(t.source.as_deref().unwrap_or(""))
    };
    add("From", from);
    add("Goal", text(&t.goal));
    if !t.success_criteria.is_empty() {
        add("Done when", text(&t.success_criteria));
    }
    add(
        "Started",
        text(&t.started_at.as_deref().map_or("–".into(), format::stamp)),
    );
    add("Model", text(&format::model_name(&t.model)));
    let trust = if t.injection_suspected {
        "Possible prompt injection"
    } else if !t.tainted {
        "Trusted sources only"
    } else if t.lane == "screen" {
        "Read web pages"
    } else {
        "Read untrusted content"
    };
    let trust = text(trust);
    if t.injection_suspected {
        trust.add_css_class("warning");
    }
    add("Trust", trust);
    if let Some(by) = &t.tainted_by {
        add("Tainted by", text(by));
    }
    add("Cost", text(&format::money(t.cost_usd)));
    // A memory note opens in Memory (L5); a research task's report file opens here.
    let report = files.iter().find(|a| is_markdown(a)).filter(|_| t.research);
    if let Some(a) = report {
        let b = gtk::Button::builder()
            .label(&a.name)
            .halign(gtk::Align::Start)
            .css_classes(["flat"])
            .build();
        let (store, a) = (store.clone(), a.clone());
        b.connect_clicked(move |b| read(&store, &a, b));
        add("Report", b.upcast());
    } else if let Some(path) = &t.report_path {
        add("Report", text(path));
    }
    if let Some(payload) = &t.payload {
        let l = gtk::Label::builder()
            .label(payload)
            .xalign(0.0)
            .selectable(true)
            .css_classes(["monospace", "caption"])
            .build();
        add(
            "Event",
            gtk::ScrolledWindow::builder()
                .vscrollbar_policy(gtk::PolicyType::Never)
                .propagate_natural_height(true)
                .child(&l)
                .build()
                .upcast(),
        );
    }
    grid
}

fn step_icon(s: &TaskStep) -> &'static str {
    match s.kind {
        StepKind::Action if s.name.starts_with("memory_") => "book",
        StepKind::Action if s.name == "search_history" => "chat",
        StepKind::Note => "chat",
        StepKind::Action => "pointer",
        StepKind::Screenshot | StepKind::Task => "monitor",
        StepKind::Page => "globe",
        StepKind::Approval => "shield",
        StepKind::Takeover => "hand",
        StepKind::Error | StepKind::Unknown => "alert",
    }
}

fn step_row(store: &Store, s: &TaskStep) -> gtk::Widget {
    let icon = Icon::new(step_icon(s), 16);
    icon.set_valign(gtk::Align::Start);
    icon.set_margin_top(2);
    icon.add_css_class(
        if matches!(s.kind, StepKind::Approval | StepKind::Takeover) {
            "needs-you"
        } else {
            "dim-label"
        },
    );
    let column = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(4)
        .hexpand(true)
        .build();
    // A task it started links to it: the brain points at /tasks/<id>.
    let child = (s.kind == StepKind::Task)
        .then(|| s.url.as_deref()?.rsplit('/').next()?.parse::<i64>().ok())
        .flatten();
    let main = if let Some(id) = child {
        format!("<a href=\"hatbot://tasks/{id}\">{}</a>", escape(&s.name))
    } else if s.detail.is_empty() || s.kind == StepKind::Note {
        escape(&s.name)
    } else {
        escape(&s.detail)
    };
    column.append(&label(&main));
    if s.kind == StepKind::Note && !s.detail.is_empty() {
        let l = label(&escape(&s.detail));
        l.add_css_class("dim-label");
        column.append(&l);
    }
    if s.kind == StepKind::Page
        && let Some(url) = &s.url
    {
        let host = glib::Uri::parse(url, glib::UriFlags::NONE)
            .ok()
            .and_then(|u| u.host())
            .map_or(url.clone(), |h| h.to_string());
        column.append(&label(&format!(
            "<a href=\"{}\">{}</a>",
            escape(url),
            escape(&host)
        )));
    }
    if s.screenshot.is_some() {
        let thumb = Thumb::new(480);
        thumb.set_halign(gtk::Align::Start);
        thumb.load(store, format!("/tasks/{}/screens/{}", s.task_id, s.id));
        zoom_on_click(&thumb, "Screenshot");
        column.append(&thumb);
    }
    column.append(
        &gtk::Label::builder()
            .label(format::time_text(&s.created_at))
            .xalign(0.0)
            .css_classes(["caption", "dim-label"])
            .build(),
    );
    let line = gtk::Box::builder().spacing(10).build();
    line.append(&icon);
    line.append(&column);
    line.upcast()
}
