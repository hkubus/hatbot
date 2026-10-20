// A message's Markdown as widgets (core/markdown.rs reads it). Setting new text keeps the blocks
// that didn't change, so a streaming reply doesn't lose your selection or flicker.
use std::cell::RefCell;

use gtk::prelude::*;
use gtk::{gdk, glib};
use hatbot::core::markdown::{Block, blocks, opens};

pub struct Markdown {
    pub root: gtk::Box,
    shown: RefCell<Vec<(Block, gtk::Widget)>>,
}

impl Markdown {
    pub fn new(text: &str) -> Markdown {
        let root = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(8)
            .build();
        let md = Markdown {
            root,
            shown: RefCell::default(),
        };
        md.set(text);
        md
    }

    pub fn set(&self, text: &str) {
        let new = blocks(text);
        let mut shown = self.shown.borrow_mut();
        let same = shown
            .iter()
            .zip(&new)
            .take_while(|((a, _), b)| a == *b)
            .count();
        for (_, w) in shown.drain(same..) {
            self.root.remove(&w);
        }
        for b in new.into_iter().skip(same) {
            let w = widget(&b);
            self.root.append(&w);
            shown.push((b, w));
        }
    }
}

/// A selectable label of Pango markup whose links open only if they may.
pub fn label(markup: &str) -> gtk::Label {
    let l = gtk::Label::builder()
        .wrap(true)
        .wrap_mode(gtk::pango::WrapMode::WordChar)
        .xalign(0.0)
        .selectable(true)
        .build();
    l.set_markup(markup);
    l.connect_activate_link(|l, uri| {
        if uri
            .get(..7)
            .is_some_and(|s| s.eq_ignore_ascii_case("hatbot:"))
        {
            super::route::open(uri);
            return glib::Propagation::Stop;
        }
        if !opens(uri) {
            return glib::Propagation::Stop;
        }
        let window = l.root().and_downcast::<gtk::Window>();
        gtk::UriLauncher::new(uri).launch(window.as_ref(), gtk::gio::Cancellable::NONE, |_| {});
        glib::Propagation::Stop
    });
    l
}

fn widget(block: &Block) -> gtk::Widget {
    match block {
        Block::Paragraph(text) => label(text).upcast(),
        Block::Heading(level, text) => {
            let l = label(text);
            l.add_css_class(match level {
                1 => "title-2",
                2 => "title-3",
                3 => "title-4",
                _ => "heading",
            });
            l.upcast()
        }
        Block::Quote(text) => {
            let l = label(text);
            l.add_css_class("quote");
            l.upcast()
        }
        Block::Item {
            marker,
            depth,
            text,
        } => {
            let line = gtk::Box::builder()
                .spacing(6)
                .margin_start(*depth as i32 * 18)
                .build();
            line.append(
                &gtk::Label::builder()
                    .label(marker)
                    .yalign(0.0)
                    .width_chars(2)
                    .xalign(1.0)
                    .css_classes(["marker"])
                    .build(),
            );
            let l = label(text);
            l.set_hexpand(true);
            line.append(&l);
            line.upcast()
        }
        Block::Code { lang, text, closed } if lang == "chart" => {
            super::chart::block(text, *closed).unwrap_or_else(|| code(text))
        }
        Block::Code { text, .. } => code(text),
        Block::Table { head, rows } => table(head, rows),
        Block::Rule => gtk::Separator::new(gtk::Orientation::Horizontal).upcast(),
    }
}

fn code(text: &str) -> gtk::Widget {
    let l = gtk::Label::builder()
        .label(text)
        .xalign(0.0)
        .selectable(true)
        .css_classes(["monospace"])
        .build();
    let scroll = gtk::ScrolledWindow::builder()
        .vscrollbar_policy(gtk::PolicyType::Never)
        .propagate_natural_height(true)
        .propagate_natural_width(true)
        .child(&l)
        .build();
    let copy = gtk::Button::builder()
        .icon_name("edit-copy-symbolic")
        .tooltip_text("Copy")
        .halign(gtk::Align::End)
        .valign(gtk::Align::Start)
        .css_classes(["flat", "circular"])
        .build();
    let text = text.to_string();
    copy.connect_clicked(move |b| {
        b.clipboard().set_text(&text);
        b.set_icon_name("object-select-symbolic");
        let b = b.downgrade();
        glib::timeout_add_seconds_local_once(2, move || {
            if let Some(b) = b.upgrade() {
                b.set_icon_name("edit-copy-symbolic");
            }
        });
    });
    let overlay = gtk::Overlay::builder()
        .child(&scroll)
        .css_classes(["code"])
        .build();
    overlay.add_overlay(&copy);
    overlay.upcast()
}

fn table(head: &[String], rows: &[Vec<String>]) -> gtk::Widget {
    let grid = gtk::Grid::builder()
        .column_spacing(16)
        .row_spacing(6)
        .build();
    for (r, row) in std::iter::once(head)
        .chain(rows.iter().map(Vec::as_slice))
        .enumerate()
    {
        for (c, cell) in row.iter().enumerate() {
            let l = label(cell);
            l.set_wrap(false);
            if r == 0 {
                l.add_css_class("heading");
            }
            grid.attach(&l, c as i32, r as i32, 1, 1);
        }
    }
    gtk::ScrolledWindow::builder()
        .vscrollbar_policy(gtk::PolicyType::Never)
        .propagate_natural_height(true)
        .propagate_natural_width(true)
        .child(&grid)
        .build()
        .upcast()
}

/// Copies `text`, as "Copy" in a message's menu does.
pub fn copy(text: &str) {
    if let Some(display) = gdk::Display::default() {
        display.clipboard().set_text(text);
    }
}
