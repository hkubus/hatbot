// Files in the chat: pictures inline (a click shows them whole), Markdown in a reader, the rest opened
// in the app the desktop picks; and the files waiting in the composer while they upload.
use std::cell::{Cell, RefCell};

use adw::prelude::*;
use gtk::subclass::prelude::*;
use gtk::{gdk, gio, glib, graphene, gsk};
use hatbot::core::models::Attachment;
use hatbot::store::Store;

use super::markdown::Markdown;

mod imp {
    use super::*;

    /// A picture no bigger than `side` on its long side, with rounded corners.
    #[derive(Default)]
    pub struct Thumb {
        pub texture: RefCell<Option<gdk::Texture>>,
        pub side: Cell<i32>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for Thumb {
        const NAME: &'static str = "HatbotThumb";
        type Type = super::Thumb;
        type ParentType = gtk::Widget;

        fn class_init(klass: &mut Self::Class) {
            klass.set_accessible_role(gtk::AccessibleRole::Img);
            klass.set_css_name("thumb");
        }
    }

    impl ObjectImpl for Thumb {}

    impl WidgetImpl for Thumb {
        fn measure(&self, orientation: gtk::Orientation, _for_size: i32) -> (i32, i32, i32, i32) {
            let (w, h) = self.size();
            let s = if orientation == gtk::Orientation::Horizontal {
                w
            } else {
                h
            };
            (s, s, -1, -1)
        }

        fn snapshot(&self, snapshot: &gtk::Snapshot) {
            let w = self.obj();
            let rect = graphene::Rect::new(0.0, 0.0, w.width() as f32, w.height() as f32);
            snapshot.push_rounded_clip(&gsk::RoundedRect::from_rect(rect, 12.0));
            match self.texture.borrow().as_ref() {
                Some(t) => t.snapshot(snapshot, rect.width() as f64, rect.height() as f64),
                None => snapshot.append_color(&gdk::RGBA::new(0.5, 0.5, 0.5, 0.15), &rect),
            }
            snapshot.pop();
        }
    }

    impl Thumb {
        fn size(&self) -> (i32, i32) {
            let side = self.side.get() as f64;
            let Some(t) = self.texture.borrow().clone() else {
                return (side as i32, (side * 0.75) as i32);
            };
            let (w, h) = (t.width() as f64, t.height() as f64);
            let scale = (side / w.max(h)).min(1.0);
            ((w * scale).round() as i32, (h * scale).round() as i32)
        }
    }
}

glib::wrapper! {
    pub struct Thumb(ObjectSubclass<imp::Thumb>)
        @extends gtk::Widget,
        @implements gtk::Accessible, gtk::Buildable, gtk::ConstraintTarget;
}

impl Thumb {
    pub fn new(side: i32) -> Thumb {
        let t: Thumb = glib::Object::new();
        t.imp().side.set(side);
        t
    }

    pub fn set_texture(&self, texture: Option<gdk::Texture>) {
        self.imp().texture.replace(texture);
        self.queue_resize();
    }

    pub fn texture(&self) -> Option<gdk::Texture> {
        self.imp().texture.borrow().clone()
    }

    /// Loads the picture at `path` from the brain.
    pub fn load(&self, store: &Store, path: String) {
        let weak = self.downgrade();
        let api = store.api().clone();
        glib::spawn_future_local(async move {
            let Ok(bytes) = api.bytes(&path).await else {
                return;
            };
            if let (Some(t), Ok(texture)) = (weak.upgrade(), gdk::Texture::from_bytes(&bytes)) {
                t.set_texture(Some(texture));
            }
        });
    }
}

pub fn is_picture(a: &Attachment) -> bool {
    [
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "image/heic",
    ]
    .contains(&a.media_type.as_str())
}

pub fn is_markdown(a: &Attachment) -> bool {
    a.media_type == "text/markdown" || a.name.to_lowercase().ends_with(".md")
}

/// A message's files, on its side.
pub fn message_files(store: &Store, list: &[Attachment], align: gtk::Align) -> gtk::Box {
    let column = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(6)
        .halign(align)
        .build();
    for a in list.iter().filter(|a| !a.for_chat) {
        if is_picture(a) {
            column.append(&picture(store, a));
        } else {
            column.append(&file(store, a));
        }
    }
    column
}

fn picture(store: &Store, a: &Attachment) -> gtk::Widget {
    let thumb = Thumb::new(240);
    thumb.set_halign(gtk::Align::Start);
    thumb.update_property(&[gtk::accessible::Property::Label(&a.name)]);
    thumb.load(store, format!("/attachments/{}", a.id));
    zoom_on_click(&thumb, &a.name);
    thumb.upcast()
}

/// A click shows the picture whole, in a dialog titled `name`.
pub fn zoom_on_click(thumb: &Thumb, name: &str) {
    thumb.set_cursor_from_name(Some("pointer"));
    let click = gtk::GestureClick::new();
    let name = name.to_string();
    click.connect_released(move |g, _, _, _| {
        let Some(t) = g.widget().and_downcast::<Thumb>() else {
            return;
        };
        let Some(texture) = t.texture() else { return };
        let picture = gtk::Picture::builder()
            .paintable(&texture)
            .can_shrink(true)
            .content_fit(gtk::ContentFit::Contain)
            .build();
        let view = adw::ToolbarView::new();
        view.add_top_bar(&adw::HeaderBar::new());
        view.set_content(Some(&picture));
        let dialog = adw::Dialog::builder()
            .title(&name)
            .content_width(texture.width().min(1200))
            .content_height(texture.height().min(900) + 46)
            .child(&view)
            .build();
        dialog.present(Some(&t));
    });
    thumb.add_controller(click);
}

/// Any other file: its name; a click opens it.
fn file(store: &Store, a: &Attachment) -> gtk::Widget {
    let button = gtk::Button::builder()
        .child(&chip(&a.name))
        .halign(gtk::Align::Start)
        .css_classes(["file"])
        .build();
    let (store, a) = (store.clone(), a.clone());
    button.connect_clicked(move |b| {
        if is_markdown(&a) {
            read(&store, &a, b);
        } else {
            open(&store, &a, b);
        }
    });
    button.upcast()
}

fn chip(name: &str) -> gtk::Box {
    let line = gtk::Box::builder().spacing(8).build();
    line.append(&gtk::Image::from_icon_name("text-x-generic-symbolic"));
    line.append(
        &gtk::Label::builder()
            .label(name)
            .ellipsize(gtk::pango::EllipsizeMode::Middle)
            .max_width_chars(28)
            .build(),
    );
    line
}

/// Saved under its own name in the cache, then opened in the app the desktop picks.
fn open(store: &Store, a: &Attachment, b: &gtk::Button) {
    let dir = glib::user_cache_dir()
        .join("hatbot")
        .join("files")
        .join(a.id.to_string());
    let path = dir.join(a.name.replace('/', "_"));
    let api = store.api().clone();
    let (store, id) = (store.clone(), a.id);
    let b = b.downgrade();
    glib::spawn_future_local(async move {
        if !path.exists() {
            let Ok(bytes) = api.bytes(&format!("/attachments/{id}?download")).await else {
                store.toast("Couldn't get that file.");
                return;
            };
            if std::fs::create_dir_all(&dir)
                .and_then(|_| std::fs::write(&path, &bytes))
                .is_err()
            {
                store.toast("Couldn't save that file.");
                return;
            }
        }
        let window = b
            .upgrade()
            .and_then(|b| b.root())
            .and_downcast::<gtk::Window>();
        gtk::FileLauncher::new(Some(&gio::File::for_path(&path))).launch(
            window.as_ref(),
            gio::Cancellable::NONE,
            |_| {},
        );
    });
}

/// A Markdown file in a reader.
pub fn read(store: &Store, a: &Attachment, b: &gtk::Button) {
    let api = store.api().clone();
    let (store, a) = (store.clone(), a.clone());
    let b = b.downgrade();
    glib::spawn_future_local(async move {
        let Ok(bytes) = api.bytes(&format!("/attachments/{}", a.id)).await else {
            store.toast("Couldn't get that file.");
            return;
        };
        let Some(b) = b.upgrade() else { return };
        let md = Markdown::new(&String::from_utf8_lossy(&bytes));
        let clamp = adw::Clamp::builder()
            .maximum_size(720)
            .child(&md.root)
            .margin_top(12)
            .margin_bottom(24)
            .margin_start(18)
            .margin_end(18)
            .build();
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .child(&clamp)
            .build();
        let view = adw::ToolbarView::new();
        view.add_top_bar(&adw::HeaderBar::new());
        view.set_content(Some(&scroll));
        let dialog = adw::Dialog::builder()
            .title(&a.name)
            .content_width(760)
            .content_height(800)
            .child(&view)
            .build();
        dialog.present(Some(&b));
    });
}

/// A file in the composer: uploading, uploaded, or failed.
#[derive(Clone)]
pub struct Pending {
    pub key: u64,
    pub name: String,
    pub attachment: Option<Attachment>,
    pub failed: bool,
}

/// The files waiting in the composer, each with a button to take it out.
pub fn pending_files(files: &[Pending], remove: impl Fn(u64) + Clone + 'static) -> gtk::Widget {
    let line = gtk::Box::builder().spacing(8).build();
    for f in files {
        let c = chip(&f.name);
        let x = gtk::Button::builder()
            .icon_name("window-close-symbolic")
            .tooltip_text(format!("Remove {}", f.name))
            .css_classes(["flat", "circular"])
            .build();
        let (remove, key) = (remove.clone(), f.key);
        x.connect_clicked(move |_| remove(key));
        c.append(&x);
        c.add_css_class("pending-file");
        if f.failed {
            c.add_css_class("failed");
        } else if f.attachment.is_none() {
            c.set_opacity(0.5);
        }
        line.append(&c);
    }
    gtk::ScrolledWindow::builder()
        .vscrollbar_policy(gtk::PolicyType::Never)
        .propagate_natural_height(true)
        .child(&line)
        .build()
        .upcast()
}
