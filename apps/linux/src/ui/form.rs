// What the forms share: the confirmation, the long text field, pickers, rows that open a page and
// notes under a group.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use adw::prelude::*;
use hatbot::store::Store;

/// Asks before something that can't be undone; `then` runs if you go ahead.
pub fn confirm(
    from: &impl IsA<gtk::Widget>,
    heading: &str,
    button: &str,
    then: impl Fn() + 'static,
) {
    let dialog = adw::AlertDialog::new(Some(heading), None);
    dialog.add_responses(&[("cancel", "Cancel"), ("go", button)]);
    dialog.set_response_appearance("go", adw::ResponseAppearance::Destructive);
    dialog.set_close_response("cancel");
    dialog.connect_response(Some("go"), move |_, _| then());
    dialog.present(Some(from));
}

/// A few lines of text to write in, with a hint while it's empty.
pub struct TextArea {
    pub root: gtk::Overlay,
    pub view: gtk::TextView,
}

impl TextArea {
    pub fn new(hint: &str) -> TextArea {
        let view = gtk::TextView::builder()
            .wrap_mode(gtk::WrapMode::WordChar)
            .top_margin(10)
            .bottom_margin(10)
            .left_margin(12)
            .right_margin(12)
            .accepts_tab(false)
            .height_request(96)
            .css_classes(["card", "text-area"])
            .build();
        let placeholder = gtk::Label::builder()
            .label(hint)
            .xalign(0.0)
            .valign(gtk::Align::Start)
            .margin_top(10)
            .margin_start(12)
            .wrap(true)
            .can_target(false)
            .css_classes(["dim-label"])
            .build();
        let root = gtk::Overlay::builder().child(&view).build();
        root.add_overlay(&placeholder);
        let p = placeholder.clone();
        view.buffer()
            .connect_changed(move |b| p.set_visible(b.char_count() == 0));
        TextArea { root, view }
    }

    pub fn text(&self) -> String {
        let b = self.view.buffer();
        b.text(&b.start_iter(), &b.end_iter(), false).to_string()
    }

    pub fn set_text(&self, text: &str) {
        self.view.buffer().set_text(text);
    }
}

/// "Runs as", when there's more than one bot to pick from: the row and the ids in its order.
pub fn bot_row(store: &Store, selected: &str) -> Option<(adw::ComboRow, Vec<String>)> {
    let st = store.state();
    if st.bot_ids.len() < 2 {
        return None;
    }
    let names: Vec<String> = st.bot_ids.iter().map(|b| st.bot_name(Some(b))).collect();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    let row = adw::ComboRow::builder()
        .title("Runs as")
        .model(&gtk::StringList::new(&names))
        .build();
    let at = st.bot_ids.iter().position(|b| b == selected).unwrap_or(0);
    row.set_selected(at as u32);
    Some((row, st.bot_ids.clone()))
}

/// A line under a group's rows that says how they work.
pub fn note(text: &str) -> gtk::Label {
    gtk::Label::builder()
        .label(text)
        .xalign(0.0)
        .wrap(true)
        .margin_top(6)
        .css_classes(["caption", "dim-label"])
        .build()
}

/// Where a page's errors show, at its top.
pub fn error_label() -> gtk::Label {
    gtk::Label::builder()
        .visible(false)
        .wrap(true)
        .xalign(0.0)
        .css_classes(["error"])
        .build()
}

/// A row that opens a page.
pub fn nav_row(title: &str, open: impl Fn() + 'static) -> adw::ActionRow {
    let row = adw::ActionRow::builder()
        .title(title)
        .use_markup(false)
        .activatable(true)
        .build();
    row.add_suffix(&gtk::Image::from_icon_name("go-next-symbolic"));
    row.connect_activated(move |_| open());
    row
}

/// A picker over values with names, saying which you picked; putting it on a value doesn't.
pub struct Choice {
    pub row: adw::ComboRow,
    values: RefCell<Vec<String>>,
    syncing: Cell<bool>,
}

impl Choice {
    pub fn new(title: &str, picked: impl Fn(&str) + 'static) -> Rc<Choice> {
        let c = Rc::new(Choice {
            row: adw::ComboRow::builder().title(title).build(),
            values: RefCell::default(),
            syncing: Cell::new(false),
        });
        let weak = Rc::downgrade(&c);
        c.row.connect_selected_notify(move |row| {
            let Some(c) = weak.upgrade() else { return };
            if c.syncing.get() {
                return;
            }
            let value = c.values.borrow().get(row.selected() as usize).cloned();
            if let Some(v) = value {
                picked(&v);
            }
        });
        c
    }

    /// `choices` are (value, name).
    pub fn set(&self, choices: &[(String, String)], value: &str) {
        self.syncing.set(true);
        let names: Vec<&str> = choices.iter().map(|(_, n)| n.as_str()).collect();
        self.row.set_model(Some(&gtk::StringList::new(&names)));
        let at = choices.iter().position(|(v, _)| v == value).unwrap_or(0);
        self.row.set_selected(at as u32);
        self.values
            .replace(choices.iter().map(|(v, _)| v.clone()).collect());
        self.syncing.set(false);
    }
}
