// Under the chat: the error line, the files, the "@" and "/" suggestions, the field and Send. Enter
// sends and Shift+Enter makes a new line. Each chat keeps its own draft and files while you're away,
// and its incognito conversation another.
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use adw::prelude::*;
use gtk::{gdk, gio, glib};
use hatbot::core::models::{Bot, ConversationKind};
use hatbot::net::api::MAX_UPLOAD;
use hatbot::store::Store;

use super::files::{Pending, pending_files};

/// Chat commands (CHAT_COMMANDS in packages/shared): the brain runs them itself.
const COMMANDS: [(&str, &str, &str); 5] = [
    ("new", "", "Start a new conversation"),
    ("stop", "[task number]", "Stop the reply, or a task"),
    ("task", "<what to do>", "Run it as a background task"),
    ("remember", "<fact>", "Save it to memory as written"),
    (
        "todo",
        "[item]",
        "Add it to the to-do list, or show the list",
    ),
];

/// The commands a draft's "/…" could mean, while you type the name. In incognito only those that
/// don't outlast it.
fn commands(draft: &str, incognito: bool) -> Vec<(&'static str, &'static str, &'static str)> {
    let Some(typed) = draft.strip_prefix('/') else {
        return vec![];
    };
    if !typed.chars().all(|c| c.is_ascii_alphabetic()) {
        return vec![];
    }
    let typed = typed.to_lowercase();
    COMMANDS
        .into_iter()
        .filter(|(name, ..)| {
            name.starts_with(&typed) && (!incognito || ["new", "stop"].contains(name))
        })
        .collect()
}

/// What's typed after an "@" at the end of `draft`, or None when it doesn't end in one.
fn mention(draft: &str) -> Option<&str> {
    let at = draft.rfind('@')?;
    let typed = &draft[at + 1..];
    if typed.chars().any(|c| c.is_whitespace() || c == '@') {
        return None;
    }
    if draft[..at]
        .chars()
        .next_back()
        .is_some_and(|c| !c.is_whitespace())
    {
        return None;
    }
    Some(typed)
}

#[derive(Default)]
struct Draft {
    text: String,
    files: Vec<Pending>,
}

pub struct Composer {
    pub root: gtk::Box,
    store: Store,
    view: gtk::TextView,
    placeholder: gtk::Label,
    send: gtk::Button,
    error: gtk::Label,
    files: adw::Bin,
    suggestions: gtk::ListBox,
    drafts: RefCell<HashMap<String, Draft>>,
    key: RefCell<String>,
    members: RefCell<Vec<Bot>>,
    sending: Cell<bool>,
    next_file: Cell<u64>,
    on_sent: Box<dyn Fn()>,
    /// Itself, for the async work it starts.
    this: RefCell<std::rc::Weak<Composer>>,
}

impl Composer {
    pub fn new(store: &Store, on_sent: impl Fn() + 'static) -> Rc<Composer> {
        let view = gtk::TextView::builder()
            .wrap_mode(gtk::WrapMode::WordChar)
            .accepts_tab(false)
            .top_margin(9)
            .bottom_margin(9)
            .left_margin(14)
            .right_margin(14)
            .css_classes(["composer-field"])
            .build();
        let placeholder = gtk::Label::builder()
            .xalign(0.0)
            .valign(gtk::Align::Start)
            .margin_top(9)
            .margin_start(14)
            .can_target(false)
            .ellipsize(gtk::pango::EllipsizeMode::End)
            .css_classes(["dim-label"])
            .build();
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .propagate_natural_height(true)
            .max_content_height(200)
            .hexpand(true)
            .child(&view)
            .build();
        let field = gtk::Overlay::builder()
            .child(&scroll)
            .css_classes(["composer"])
            .build();
        field.add_overlay(&placeholder);
        let attach = gtk::Button::builder()
            .icon_name("mail-attachment-symbolic")
            .tooltip_text("Attach")
            .valign(gtk::Align::End)
            .css_classes(["circular", "composer-button"])
            .build();
        let send = gtk::Button::builder()
            .icon_name("go-up-symbolic")
            .tooltip_text("Send")
            .valign(gtk::Align::End)
            .sensitive(false)
            .css_classes(["circular", "suggested-action", "composer-button"])
            .build();
        let line = gtk::Box::builder().spacing(8).build();
        line.append(&attach);
        line.append(&field);
        line.append(&send);
        let error = gtk::Label::builder()
            .xalign(0.0)
            .wrap(true)
            .visible(false)
            .css_classes(["caption", "error"])
            .build();
        let suggestions = gtk::ListBox::builder()
            .visible(false)
            .selection_mode(gtk::SelectionMode::None)
            .css_classes(["boxed-list"])
            .build();
        let files = adw::Bin::builder().visible(false).build();
        let root = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(6)
            .build();
        root.append(&error);
        root.append(&files);
        root.append(&suggestions);
        root.append(&line);

        let c = Rc::new(Composer {
            root,
            store: store.clone(),
            view,
            placeholder,
            send,
            error,
            files,
            suggestions,
            drafts: RefCell::default(),
            key: RefCell::default(),
            members: RefCell::default(),
            sending: Cell::new(false),
            next_file: Cell::new(0),
            on_sent: Box::new(on_sent),
            this: RefCell::default(),
        });
        c.this.replace(Rc::downgrade(&c));

        let weak = Rc::downgrade(&c);
        c.view.buffer().connect_changed(move |_| {
            if let Some(c) = weak.upgrade() {
                c.changed();
            }
        });
        let keys = gtk::EventControllerKey::new();
        keys.set_propagation_phase(gtk::PropagationPhase::Capture);
        let weak = Rc::downgrade(&c);
        keys.connect_key_pressed(move |_, key, _, mods| {
            let Some(c) = weak.upgrade() else {
                return glib::Propagation::Proceed;
            };
            let enter = matches!(
                key,
                gdk::Key::Return | gdk::Key::KP_Enter | gdk::Key::ISO_Enter
            );
            if enter && !mods.contains(gdk::ModifierType::SHIFT_MASK) {
                // Enter on a suggestion picks it, as clicking does.
                if let Some(row) = c.suggestions.row_at_index(0)
                    && c.suggestions.is_visible()
                {
                    row.activate();
                } else {
                    c.submit(None);
                }
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
        c.view.add_controller(keys);
        let weak = Rc::downgrade(&c);
        c.send.connect_clicked(move |_| {
            if let Some(c) = weak.upgrade() {
                c.submit(None);
            }
        });
        let weak = Rc::downgrade(&c);
        attach.connect_clicked(move |b| {
            if let Some(c) = weak.upgrade() {
                c.pick(b);
            }
        });
        let drop = gtk::DropTarget::new(gdk::FileList::static_type(), gdk::DragAction::COPY);
        let weak = Rc::downgrade(&c);
        drop.connect_drop(move |_, value, _, _| {
            let (Some(c), Ok(list)) = (weak.upgrade(), value.get::<gdk::FileList>()) else {
                return false;
            };
            c.attach(list.files());
            true
        });
        c.root.add_controller(drop);
        let weak = Rc::downgrade(&c);
        c.suggestions.connect_row_activated(move |_, row| {
            if let Some(c) = weak.upgrade() {
                c.pick_suggestion(row.index() as usize);
            }
        });
        c.sync();
        c
    }

    fn text(&self) -> String {
        let b = self.view.buffer();
        b.text(&b.start_iter(), &b.end_iter(), false).to_string()
    }

    fn set_text(&self, text: &str) {
        self.view.buffer().set_text(text);
        let b = self.view.buffer();
        b.place_cursor(&b.end_iter());
    }

    pub fn focus(&self) {
        self.view.grab_focus();
    }

    /// The chat or incognito changed: the other one's draft, name and members.
    pub fn sync(&self) {
        let (key, name, incognito, members) = {
            let st = self.store.state();
            let c = st.current_chat();
            let members: Vec<Bot> = c
                .filter(|c| c.kind == ConversationKind::Group)
                .map(|c| {
                    c.bot_ids
                        .iter()
                        .filter_map(|b| st.bots.get(b).cloned())
                        .collect()
                })
                .unwrap_or_default();
            let key = format!(
                "{}{}",
                st.conversation_id,
                if st.incognito { "i" } else { "" }
            );
            (key, st.chat_name(c), st.incognito, members)
        };
        self.placeholder.set_label(&if incognito {
            format!("Message {name} incognito…")
        } else {
            format!("Message {name}…")
        });
        self.members.replace(members);
        let old = self.key.replace(key.clone());
        if old != key {
            let text = self.text();
            self.drafts.borrow_mut().entry(old).or_default().text = text;
            let text = self
                .drafts
                .borrow()
                .get(&key)
                .map(|d| d.text.clone())
                .unwrap_or_default();
            self.set_text(&text);
            self.error.set_visible(false);
            self.show_files();
        }
        self.changed();
    }

    fn files(&self) -> Vec<Pending> {
        self.drafts
            .borrow()
            .get(&*self.key.borrow())
            .map(|d| d.files.clone())
            .unwrap_or_default()
    }

    fn changed(&self) {
        let text = self.text();
        self.placeholder.set_visible(text.is_empty());
        let files = self.files();
        let uploading = files.iter().any(|f| f.attachment.is_none() && !f.failed);
        let has_files = files.iter().any(|f| f.attachment.is_some());
        self.send.set_sensitive(
            (!text.trim().is_empty() || has_files) && !self.sending.get() && !uploading,
        );
        self.suggest(&text);
    }

    /// "@…" in a group, else "/…".
    fn suggest(&self, text: &str) {
        while let Some(row) = self.suggestions.row_at_index(0) {
            self.suggestions.remove(&row);
        }
        let rows: Vec<(String, String)> = match mention(text) {
            Some(partial) if !self.members.borrow().is_empty() => {
                let p = partial.to_lowercase();
                self.members
                    .borrow()
                    .iter()
                    .filter(|b| b.id.starts_with(&p) || b.name.to_lowercase().starts_with(&p))
                    .map(|b| {
                        (
                            format!("@{}", b.name),
                            b.instructions.lines().next().unwrap_or("").to_string(),
                        )
                    })
                    .collect()
            }
            _ => commands(text, self.store.state().incognito)
                .into_iter()
                .map(|(name, args, about)| {
                    let args = if args.is_empty() {
                        String::new()
                    } else {
                        format!(" {args}")
                    };
                    (format!("/{name}{args}"), about.to_string())
                })
                .collect(),
        };
        for (name, about) in &rows {
            let row = adw::ActionRow::builder()
                .title(name)
                .use_markup(false)
                .activatable(true)
                .build();
            row.add_suffix(
                &gtk::Label::builder()
                    .label(about)
                    .ellipsize(gtk::pango::EllipsizeMode::End)
                    .css_classes(["caption", "dim-label"])
                    .build(),
            );
            self.suggestions.append(&row);
        }
        self.suggestions.set_visible(!rows.is_empty());
    }

    fn pick_suggestion(&self, i: usize) {
        let text = self.text();
        if let Some(partial) = mention(&text)
            && !self.members.borrow().is_empty()
        {
            let p = partial.to_lowercase();
            let name = self
                .members
                .borrow()
                .iter()
                .filter(|b| b.id.starts_with(&p) || b.name.to_lowercase().starts_with(&p))
                .nth(i)
                .map(|b| b.name.clone());
            if let Some(name) = name {
                self.set_text(&format!(
                    "{}@{name} ",
                    &text[..text.len() - partial.len() - 1]
                ));
            }
            return;
        }
        let Some((name, args, _)) = commands(&text, self.store.state().incognito)
            .into_iter()
            .nth(i)
        else {
            return;
        };
        // One that needs more goes in the field to finish; the rest run at once.
        if args.starts_with('<') {
            self.set_text(&format!("/{name} "));
        } else {
            self.submit(Some(format!("/{name}")));
        }
    }

    /// Sends the field, or `command` when you picked one. Cleared as it goes, and put back if
    /// sending fails.
    fn submit(&self, command: Option<String>) {
        let typed = command.clone().unwrap_or_else(|| self.text());
        let text = typed.trim().to_string();
        if command.is_none() && !self.send.is_sensitive() || self.sending.get() {
            return;
        }
        let key = self.key.borrow().clone();
        let attached = if command.is_none() {
            std::mem::take(
                &mut self
                    .drafts
                    .borrow_mut()
                    .entry(key.clone())
                    .or_default()
                    .files,
            )
        } else {
            vec![]
        };
        let ids: Vec<i64> = attached
            .iter()
            .filter_map(|f| f.attachment.as_ref().map(|a| a.id))
            .collect();
        self.sending.set(true);
        self.error.set_visible(false);
        if command.is_none() {
            self.set_text("");
        }
        self.show_files();
        self.changed();
        (self.on_sent)();
        let store = self.store.clone();
        let this = self.weak();
        glib::spawn_future_local(async move {
            let client = glib::uuid_string_random();
            let result = store.send(&text, &ids, &client).await;
            let Some(c) = this.upgrade() else { return };
            c.sending.set(false);
            if let Err(e) = result {
                // Back where it was, if you're still in that chat and haven't started another.
                if *c.key.borrow() == key && command.is_none() && c.text().is_empty() {
                    c.set_text(&typed);
                }
                let mut drafts = c.drafts.borrow_mut();
                let d = drafts.entry(key).or_default();
                if d.files.is_empty() {
                    d.files = attached;
                }
                drop(drafts);
                c.error.set_label(&e.message);
                c.error.set_visible(true);
                c.show_files();
            }
            c.changed();
        });
    }

    fn weak(&self) -> std::rc::Weak<Composer> {
        self.this.borrow().clone()
    }

    fn pick(&self, from: &gtk::Button) {
        let dialog = gtk::FileDialog::builder()
            .title("Attach")
            .modal(true)
            .build();
        let window = from.root().and_downcast::<gtk::Window>();
        let this = self.weak();
        dialog.open_multiple(window.as_ref(), gio::Cancellable::NONE, move |result| {
            let (Some(c), Ok(list)) = (this.upgrade(), result) else {
                return;
            };
            let files: Vec<gio::File> = (0..list.n_items())
                .filter_map(|i| list.item(i).and_downcast::<gio::File>())
                .collect();
            c.attach(files);
        });
    }

    /// Adds files to the composer and uploads them straight away, up to ten at a time.
    fn attach(&self, files: Vec<gio::File>) {
        let key = self.key.borrow().clone();
        for file in files.into_iter().take(10) {
            let name = file
                .basename()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".into());
            let id = self.next_file.get() + 1;
            self.next_file.set(id);
            self.drafts
                .borrow_mut()
                .entry(key.clone())
                .or_default()
                .files
                .push(Pending {
                    key: id,
                    name: name.clone(),
                    attachment: None,
                    failed: false,
                });
            let (store, this, key) = (self.store.clone(), self.weak(), key.clone());
            glib::spawn_future_local(async move {
                let result = match file.load_contents_future().await {
                    Ok((data, _)) if data.len() as u64 > MAX_UPLOAD => {
                        Err(format!("{name} is over 25 MB."))
                    }
                    Ok((data, _)) => {
                        let (guess, _) = gio::content_type_guess(Some(&name), Some(&data[..]));
                        let media = gio::content_type_get_mime_type(&guess)
                            .map(|m| m.to_string())
                            .unwrap_or_else(|| "application/octet-stream".into());
                        store
                            .upload(&name, &media, &data)
                            .await
                            .map_err(|e| e.message)
                    }
                    Err(_) => Err(format!("Couldn't read {name}.")),
                };
                let Some(c) = this.upgrade() else { return };
                // The chat it was attached in, even if you've gone to another meanwhile.
                if let Some(f) = c
                    .drafts
                    .borrow_mut()
                    .get_mut(&key)
                    .and_then(|d| d.files.iter_mut().find(|f| f.key == id))
                {
                    match &result {
                        Ok(a) => f.attachment = Some(a.clone()),
                        Err(_) => f.failed = true,
                    }
                }
                if let Err(e) = result {
                    c.error.set_label(&e);
                    c.error.set_visible(true);
                }
                c.show_files();
                c.changed();
            });
        }
        self.show_files();
        self.changed();
    }

    fn show_files(&self) {
        let files = self.files();
        self.files.set_visible(!files.is_empty());
        let this = self.weak();
        self.files.set_child(Some(&pending_files(&files, move |id| {
            let Some(c) = this.upgrade() else { return };
            let key = c.key.borrow().clone();
            if let Some(d) = c.drafts.borrow_mut().get_mut(&key) {
                d.files.retain(|f| f.key != id);
            }
            c.show_files();
            c.changed();
        })));
    }
}
