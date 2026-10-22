// An icon from icon_paths.rs, stroked in the widget's CSS colour by GSK: crisp at any scale, and
// in a bot's colour or the text's.
use std::cell::{Cell, RefCell};

use gtk::prelude::*;
use gtk::subclass::prelude::*;
use gtk::{glib, graphene, gsk};

use super::icon_paths::{BOT_ICONS, ICONS};

mod imp {
    use super::*;

    #[derive(Default)]
    pub struct Icon {
        pub paths: RefCell<Vec<gsk::Path>>,
        pub size: Cell<i32>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for Icon {
        const NAME: &'static str = "HatbotIcon";
        type Type = super::Icon;
        type ParentType = gtk::Widget;

        fn class_init(klass: &mut Self::Class) {
            klass.set_accessible_role(gtk::AccessibleRole::Presentation);
            klass.set_css_name("icon");
        }
    }

    impl ObjectImpl for Icon {}

    impl WidgetImpl for Icon {
        fn measure(&self, _orientation: gtk::Orientation, _for_size: i32) -> (i32, i32, i32, i32) {
            let s = self.size.get();
            (s, s, -1, -1)
        }

        fn snapshot(&self, snapshot: &gtk::Snapshot) {
            let w = self.obj();
            let (width, height) = (w.width() as f32, w.height() as f32);
            let size = width.min(height);
            let stroke = gsk::Stroke::new(2.0);
            stroke.set_line_cap(gsk::LineCap::Round);
            stroke.set_line_join(gsk::LineJoin::Round);
            snapshot.save();
            snapshot.translate(&graphene::Point::new(
                (width - size) / 2.0,
                (height - size) / 2.0,
            ));
            snapshot.scale(size / 24.0, size / 24.0);
            let color = w.color();
            for path in self.paths.borrow().iter() {
                snapshot.append_stroke(path, &stroke, &color);
            }
            snapshot.restore();
        }
    }
}

glib::wrapper! {
    pub struct Icon(ObjectSubclass<imp::Icon>)
        @extends gtk::Widget,
        @implements gtk::Accessible, gtk::Buildable, gtk::ConstraintTarget;
}

fn parse(data: &str) -> Vec<gsk::Path> {
    data.split('|')
        .filter_map(|d| gsk::Path::parse(d).ok())
        .collect()
}

impl Icon {
    pub fn new(name: &str, size: i32) -> Icon {
        let icon: Icon = glib::Object::new();
        icon.imp().size.set(size);
        icon.set_name(name);
        icon
    }

    /// A bot's icon in its colour (CSS class `bot-<colour>`).
    pub fn bot(icon: &str, color: &str, size: i32) -> Icon {
        let data = BOT_ICONS
            .iter()
            .find(|(n, _)| *n == icon)
            .or(BOT_ICONS.first())
            .map_or("", |(_, d)| d);
        let w: Icon = glib::Object::new();
        w.imp().size.set(size);
        w.imp().paths.replace(parse(data));
        w.add_css_class(&format!("bot-{color}"));
        w
    }

    pub fn set_name(&self, name: &str) {
        let data = ICONS
            .iter()
            .find(|(n, _)| *n == name)
            .map_or("", |(_, d)| d);
        self.imp().paths.replace(parse(data));
        self.queue_draw();
    }

    pub fn set_bot(&self, icon: &str, color: &str) {
        let data = BOT_ICONS
            .iter()
            .find(|(n, _)| *n == icon)
            .or(BOT_ICONS.first())
            .map_or("", |(_, d)| d);
        self.imp().paths.replace(parse(data));
        for c in self.css_classes() {
            if c.starts_with("bot-") {
                self.remove_css_class(&c);
            }
        }
        self.add_css_class(&format!("bot-{color}"));
        self.queue_draw();
    }
}
