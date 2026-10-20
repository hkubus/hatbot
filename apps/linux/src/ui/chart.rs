// A ```chart block in a reply, drawn in Hatbot's colours as on iOS (ChartView.swift) and the web:
// lines, columns (grouped or stacked), horizontal bars, scatter plots, ranges and timelines, and a
// matrix as a grid of shaded cells. Point at it for the values there.
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gtk::prelude::*;
use gtk::subclass::prelude::*;
use gtk::{gdk, glib, graphene, gsk, pango};
use hatbot::core::chart::{
    self, ChartFile, ChartSpec, Kind, Matrix, Ranges, Scatter, Series, Timeline, format, nice_ticks,
};
use hatbot::net::api::Api;
use serde_json::Value;

thread_local! {
    static API: RefCell<Option<Api>> = RefCell::default();
    /// The brain's answers for file charts, by server and path: the chat draws them again as you
    /// scroll and as replies stream in.
    static ANSWERS: RefCell<HashMap<String, Value>> = RefCell::default();
}

/// Where file charts get their values: the signed-in brain. Someone else signing in doesn't see
/// the last one's answers.
pub fn set_api(api: Api) {
    API.with(|a| a.replace(Some(api)));
    ANSWERS.with(|a| a.borrow_mut().clear());
}

/// About a chart's height, while its block is still streaming in.
const PENDING_HEIGHT: i32 = 170;

/// A chart block's widget: the chart, a file chart loading, or a placeholder while the block streams
/// in. None for a block that doesn't draw, which stays code.
pub fn block(text: &str, closed: bool) -> Option<gtk::Widget> {
    if let Some(spec) = ChartSpec::parse(text) {
        return Some(view(&spec));
    }
    if let Some(file) = ChartFile::parse(text) {
        return Some(file_view(file));
    }
    (!closed).then(pending)
}

/// A chart with nothing drawn yet, so its bubble is a chart's width.
fn pending() -> gtk::Widget {
    let p: Plot = glib::Object::new();
    p.add_css_class("chart-pending");
    p.upcast()
}

/// The chart with its title, and for a matrix what its shades mean.
pub fn view(spec: &ChartSpec) -> gtk::Widget {
    let column = gtk::Box::new(gtk::Orientation::Vertical, 6);
    if let Some(title) = spec.title.as_deref().filter(|t| !t.is_empty()) {
        column.append(
            &gtk::Label::builder()
                .label(title)
                .xalign(0.0)
                .wrap(true)
                .css_classes(["chart-title"])
                .build(),
        );
    }
    let plot = Plot::new(spec.clone());
    if let Kind::Matrix(m) = &spec.kind {
        // Wider than the bubble, it scrolls sideways.
        column.append(
            &gtk::ScrolledWindow::builder()
                .vscrollbar_policy(gtk::PolicyType::Never)
                .propagate_natural_height(true)
                .propagate_natural_width(true)
                .child(&plot)
                .build(),
        );
        if m.rows.len() > 1 {
            column.append(
                &gtk::Label::builder()
                    .label("Darker is better in each column.")
                    .xalign(0.0)
                    .css_classes(["caption", "dim-label"])
                    .build(),
            );
        }
    } else {
        column.append(&plot);
    }
    column.upcast()
}

fn file_view(file: ChartFile) -> gtk::Widget {
    let holder = gtk::Box::new(gtk::Orientation::Vertical, 0);
    holder.append(&pending());
    let Some(api) = API.with(|a| a.borrow().clone()) else {
        return holder.upcast();
    };
    let key = format!("{}{}", api.server(), file.path());
    let show = {
        let holder = holder.clone();
        move |w: gtk::Widget| {
            while let Some(c) = holder.first_child() {
                holder.remove(&c);
            }
            holder.append(&w);
        }
    };
    let didnt_load = || {
        gtk::Label::builder()
            .label("The chart's data didn't load.")
            .xalign(0.0)
            .wrap(true)
            .css_classes(["dim-label"])
            .build()
            .upcast::<gtk::Widget>()
    };
    if let Some(answer) = ANSWERS.with(|a| a.borrow().get(&key).cloned()) {
        show(file.spec(&answer).map_or_else(didnt_load, |s| view(&s)));
        return holder.upcast();
    }
    glib::spawn_future_local(async move {
        match api.get::<Value>(&file.path()).await {
            Ok(answer) => {
                let spec = file.spec(&answer);
                ANSWERS.with(|a| a.borrow_mut().insert(key, answer));
                show(spec.map_or_else(didnt_load, |s| view(&s)));
            }
            // The brain says why the file doesn't draw.
            Err(e) if e.status == 404 || e.status == 422 => {
                show(
                    gtk::Label::builder()
                        .label(&e.message)
                        .xalign(0.0)
                        .wrap(true)
                        .css_classes(["dim-label"])
                        .build()
                        .upcast(),
                );
            }
            Err(_) => show(didnt_load()),
        }
    });
    holder.upcast()
}

mod imp {
    use super::*;

    #[derive(Default)]
    pub struct Plot {
        pub spec: RefCell<Option<Rc<ChartSpec>>>,
        pub hover: Cell<Option<(f32, f32)>>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for Plot {
        const NAME: &'static str = "HatbotChart";
        type Type = super::Plot;
        type ParentType = gtk::Widget;

        fn class_init(klass: &mut Self::Class) {
            klass.set_css_name("chart");
            klass.set_accessible_role(gtk::AccessibleRole::Img);
        }
    }

    impl ObjectImpl for Plot {}

    impl WidgetImpl for Plot {
        fn request_mode(&self) -> gtk::SizeRequestMode {
            gtk::SizeRequestMode::HeightForWidth
        }

        fn measure(&self, orientation: gtk::Orientation, for_size: i32) -> (i32, i32, i32, i32) {
            let Some(spec) = self.spec.borrow().clone() else {
                return if orientation == gtk::Orientation::Horizontal {
                    (240, 560, -1, -1)
                } else {
                    (PENDING_HEIGHT, PENDING_HEIGHT, -1, -1)
                };
            };
            let w = self.obj();
            let ink = Ink::new(w.upcast_ref());
            if let Kind::Matrix(m) = &spec.kind {
                let grid = MatrixGrid::new(&ink, m);
                let size = if orientation == gtk::Orientation::Horizontal {
                    grid.width()
                } else {
                    grid.height()
                };
                return (size as i32, size as i32, -1, -1);
            }
            if orientation == gtk::Orientation::Horizontal {
                return (240, 560, -1, -1);
            }
            let h = height(&ink, &spec, if for_size > 0 { for_size } else { 560 }) as i32;
            (h, h, -1, -1)
        }

        fn snapshot(&self, snapshot: &gtk::Snapshot) {
            let Some(spec) = self.spec.borrow().clone() else {
                return;
            };
            let w = self.obj();
            let mut ink = Ink::new(w.upcast_ref());
            ink.snap = Some(snapshot.clone());
            ink.hover = self.hover.get();
            draw(&ink, &spec);
        }
    }
}

glib::wrapper! {
    pub struct Plot(ObjectSubclass<imp::Plot>)
        @extends gtk::Widget,
        @implements gtk::Accessible, gtk::Buildable, gtk::ConstraintTarget;
}

impl Plot {
    pub fn new(spec: ChartSpec) -> Plot {
        let p: Plot = glib::Object::new();
        p.imp().spec.replace(Some(Rc::new(spec)));
        if !matches!(
            p.imp().spec.borrow().as_deref().map(|s| &s.kind),
            Some(Kind::Matrix(_))
        ) {
            let motion = gtk::EventControllerMotion::new();
            let weak = p.downgrade();
            motion.connect_motion(move |_, x, y| {
                if let Some(p) = weak.upgrade() {
                    p.imp().hover.set(Some((x as f32, y as f32)));
                    p.queue_draw();
                }
            });
            let weak = p.downgrade();
            motion.connect_leave(move |_| {
                if let Some(p) = weak.upgrade() {
                    p.imp().hover.set(None);
                    p.queue_draw();
                }
            });
            p.add_controller(motion);
        }
        p
    }
}

/// Series colours, in order; checked for colour-blind separation on the bot bubble.
fn palette(dark: bool) -> [gdk::RGBA; 3] {
    let c = |hex: u32| {
        gdk::RGBA::new(
            ((hex >> 16) & 0xff) as f32 / 255.0,
            ((hex >> 8) & 0xff) as f32 / 255.0,
            (hex & 0xff) as f32 / 255.0,
            1.0,
        )
    };
    if dark {
        [c(0xD87A12), c(0x3987E5), c(0x199E70)]
    } else {
        [c(0xC96F0A), c(0x2A78D6), c(0x138A60)]
    }
}

fn alpha(c: &gdk::RGBA, a: f32) -> gdk::RGBA {
    gdk::RGBA::new(c.red(), c.green(), c.blue(), c.alpha() * a)
}

fn hex(c: &gdk::RGBA) -> String {
    let b = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", b(c.red()), b(c.green()), b(c.blue()))
}

fn esc(text: &str) -> String {
    glib::markup_escape_text(text).to_string()
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        text.chars().take(max - 1).collect::<String>() + "…"
    }
}

const LEGEND: f32 = 22.0;

/// What drawing needs: the widget's text and colours, the snapshot, and where the pointer is.
struct Ink {
    widget: gtk::Widget,
    snap: Option<gtk::Snapshot>,
    width: f32,
    height: f32,
    hover: Option<(f32, f32)>,
    fg: gdk::RGBA,
    dark: bool,
    colors: [gdk::RGBA; 3],
}

impl Ink {
    fn new(widget: &gtk::Widget) -> Ink {
        let dark = adw::StyleManager::default().is_dark();
        Ink {
            widget: widget.clone(),
            snap: None,
            width: widget.width() as f32,
            height: widget.height() as f32,
            hover: None,
            fg: widget.color(),
            dark,
            colors: palette(dark),
        }
    }

    fn snap(&self) -> &gtk::Snapshot {
        self.snap.as_ref().expect("drawing")
    }

    fn secondary(&self) -> gdk::RGBA {
        alpha(&self.fg, 0.6)
    }

    /// The bot bubble's colour, for the ring round a dot where lines cross it.
    fn bubble(&self) -> gdk::RGBA {
        let (bg, mix) = if self.dark {
            (
                (
                    0x22 as f32 / 255.0,
                    0x22 as f32 / 255.0,
                    0x26 as f32 / 255.0,
                ),
                0.08,
            )
        } else {
            ((0.98, 0.98, 0.984), 0.08)
        };
        let m = |b: f32, f: f32| b * (1.0 - mix) + f * mix;
        gdk::RGBA::new(
            m(bg.0, self.fg.red()),
            m(bg.1, self.fg.green()),
            m(bg.2, self.fg.blue()),
            1.0,
        )
    }

    /// Caption-sized text with figures of one width.
    fn text(&self, text: &str, bold: bool) -> pango::Layout {
        let l = self.widget.create_pango_layout(Some(text));
        let mut fd = self
            .widget
            .pango_context()
            .font_description()
            .unwrap_or_default();
        let size = if fd.size() > 0 {
            fd.size()
        } else {
            11 * pango::SCALE
        };
        fd.set_size((size as f64 * 0.82) as i32);
        if bold {
            fd.set_weight(pango::Weight::Semibold);
        }
        l.set_font_description(Some(&fd));
        let attrs = pango::AttrList::new();
        attrs.insert(pango::AttrFontFeatures::new("tnum"));
        l.set_attributes(Some(&attrs));
        l
    }

    fn markup(&self, markup: &str) -> pango::Layout {
        let l = self.text("", false);
        l.set_markup(markup);
        l
    }

    fn size(l: &pango::Layout) -> (f32, f32) {
        let (w, h) = l.pixel_size();
        (w as f32, h as f32)
    }

    fn put(&self, l: &pango::Layout, x: f32, y: f32, color: &gdk::RGBA) {
        let s = self.snap();
        s.save();
        s.translate(&graphene::Point::new(x.round(), y.round()));
        s.append_layout(l, color);
        s.restore();
    }

    fn rect(&self, x: f32, y: f32, w: f32, h: f32, color: &gdk::RGBA) {
        self.snap()
            .append_color(color, &graphene::Rect::new(x, y, w, h));
    }

    /// A bar rounded at the corners given as (top left, top right, bottom right, bottom left).
    fn bar(&self, x: f32, y: f32, w: f32, h: f32, corners: [bool; 4], color: &gdk::RGBA) {
        let r = 4f32.min(w / 2.0).min(h / 2.0).max(0.0);
        let size = |on: bool| {
            if on {
                graphene::Size::new(r, r)
            } else {
                graphene::Size::zero()
            }
        };
        let rr = gsk::RoundedRect::new(
            graphene::Rect::new(x, y, w, h),
            size(corners[0]),
            size(corners[1]),
            size(corners[2]),
            size(corners[3]),
        );
        let s = self.snap();
        s.push_rounded_clip(&rr);
        s.append_color(color, &graphene::Rect::new(x, y, w, h));
        s.pop();
    }

    fn circle(&self, x: f32, y: f32, r: f32, color: &gdk::RGBA) {
        let rr =
            gsk::RoundedRect::from_rect(graphene::Rect::new(x - r, y - r, 2.0 * r, 2.0 * r), r);
        let s = self.snap();
        s.push_rounded_clip(&rr);
        s.append_color(color, &graphene::Rect::new(x - r, y - r, 2.0 * r, 2.0 * r));
        s.pop();
    }

    /// An 8px dot with a 2px ring of the bubble's colour, so it stays clear where lines cross.
    fn dot(&self, x: f32, y: f32, color: &gdk::RGBA) {
        self.circle(x, y, 6.0, &self.bubble());
        self.circle(x, y, 4.0, color);
    }

    fn line(&self, points: &[(f32, f32)], width: f32, color: &gdk::RGBA) {
        let Some((first, rest)) = points.split_first() else {
            return;
        };
        let b = gsk::PathBuilder::new();
        b.move_to(first.0, first.1);
        for p in rest {
            b.line_to(p.0, p.1);
        }
        let stroke = gsk::Stroke::new(width);
        stroke.set_line_cap(gsk::LineCap::Round);
        stroke.set_line_join(gsk::LineJoin::Round);
        self.snap().append_stroke(&b.to_path(), &stroke, color);
    }

    fn rule_x(&self, x: f32, top: f32, bottom: f32, color: &gdk::RGBA) {
        self.rect(x.round() - 0.5, top, 1.0, bottom - top, color);
    }

    fn rule_y(&self, y: f32, left: f32, right: f32, color: &gdk::RGBA) {
        self.rect(left, y.round() - 0.5, right - left, 1.0, color);
    }

    fn grid(&self) -> gdk::RGBA {
        alpha(&self.fg, 0.1)
    }

    fn zero(&self) -> gdk::RGBA {
        alpha(&self.fg, 0.35)
    }

    /// The legend: each series' key and name, in a row at the top.
    fn legend(&self, names: &[String], key: Key) {
        let mut x = 0.0;
        for (i, name) in names.iter().enumerate() {
            let c = &self.colors[i.min(2)];
            match key {
                Key::Line => self.bar(x, 9.0, 12.0, 2.0, [true; 4], c),
                Key::Bar => self.bar(x, 6.0, 8.0, 8.0, [true; 4], c),
                Key::Point => self.circle(x + 4.0, 10.0, 4.0, c),
            }
            let l = self.text(name, false);
            let (w, h) = Ink::size(&l);
            let kw = if key == Key::Line { 12.0 } else { 8.0 };
            self.put(&l, x + kw + 5.0, 10.0 - h / 2.0, &self.secondary());
            x += kw + 5.0 + w + 14.0;
        }
    }

    /// The box the pointer's values show in: value first, then what it is.
    fn readout(&self, markup: &str, anchor: f32, top: f32) {
        let l = self.markup(markup);
        let (w, h) = Ink::size(&l);
        let (bw, bh) = (w + 16.0, h + 10.0);
        let mut x = anchor + 12.0;
        if x + bw > self.width {
            x = anchor - 12.0 - bw;
        }
        let x = x.max(0.0);
        // Inside the chart: past its edge it would be under the next message.
        let top = top.min(self.height - bh).max(0.0);
        let bg = if self.dark {
            gdk::RGBA::new(0.2, 0.2, 0.22, 1.0)
        } else {
            gdk::RGBA::new(1.0, 1.0, 1.0, 1.0)
        };
        let border = alpha(&self.fg, 0.15);
        let rect = graphene::Rect::new(x, top, bw, bh);
        let s = self.snap();
        let rr = gsk::RoundedRect::from_rect(rect, 8.0);
        s.push_rounded_clip(&rr);
        s.append_color(&bg, &rect);
        s.pop();
        s.append_border(&rr, &[0.5; 4], &[border, border, border, border]);
        self.put(&l, x + 8.0, top + 5.0, &self.fg);
    }

    fn swatch(&self, i: usize, glyph: &str) -> String {
        format!(
            "<span foreground=\"{}\">{glyph}</span>",
            hex(&self.colors[i.min(2)])
        )
    }

    fn dim(&self, text: &str) -> String {
        format!(
            "<span foreground=\"{}\" fgalpha=\"60%\">{}</span>",
            hex(&self.fg),
            esc(text)
        )
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Key {
    Line,
    Bar,
    Point,
}

fn height(ink: &Ink, spec: &ChartSpec, width: i32) -> f32 {
    match &spec.kind {
        Kind::Line(s) | Kind::Bar(s) => {
            let bar = matches!(spec.kind, Kind::Bar(_));
            let legend = if s.series.len() > 1 { LEGEND } else { 0.0 };
            if bar && s.horizontal {
                legend + s.x.len() as f32 * row_height(s, bar)
            } else {
                legend + 8.0 + PLOT + AXIS
            }
        }
        Kind::Scatter(s) => {
            let names = |n: &Option<String>| {
                if n.as_deref().is_some_and(|n| !n.is_empty()) {
                    18.0
                } else {
                    0.0
                }
            };
            let legend = if s.series.len() > 1 { LEGEND } else { 0.0 };
            legend + names(&s.y_name) + 8.0 + 190.0 + AXIS + names(&s.x_name)
        }
        Kind::Range(r) => {
            let legend = if r.rows.iter().any(|r| r.mark.is_some()) {
                LEGEND
            } else {
                0.0
            };
            legend + r.rows.len() as f32 * 24.0 + 24.0
        }
        Kind::Timeline(t) => t.lanes().len() as f32 * 40.0 + 28.0,
        Kind::Matrix(m) => {
            let _ = width;
            MatrixGrid::new(ink, m).height()
        }
    }
}

fn draw(ink: &Ink, spec: &ChartSpec) {
    match &spec.kind {
        Kind::Line(s) => columns(ink, s, false),
        Kind::Bar(s) if s.horizontal => rows(ink, s),
        Kind::Bar(s) => columns(ink, s, true),
        Kind::Scatter(s) => scatter(ink, s),
        Kind::Range(r) => ranges(ink, r),
        Kind::Matrix(m) => MatrixGrid::new(ink, m).draw(ink),
        Kind::Timeline(t) => timeline(ink, t),
    }
}

const PLOT: f32 = 150.0;
const AXIS: f32 = 24.0;

/// A value axis's ticks and their labels' widest.
fn ticks(
    ink: &Ink,
    lo: f64,
    hi: f64,
    unit: Option<&str>,
    count: usize,
) -> (Vec<f64>, Vec<pango::Layout>, f32) {
    let t = nice_ticks(lo, hi, count);
    let labels: Vec<pango::Layout> = t
        .iter()
        .map(|v| ink.text(&format(*v, unit, true), false))
        .collect();
    let widest = labels.iter().map(|l| Ink::size(l).0).fold(0.0, f32::max);
    (t, labels, widest)
}

/// The x labels that fit with room between them: every one if they all do, otherwise every
/// step-th.
fn shown_labels(labels: &[pango::Layout], plot: f32) -> Vec<usize> {
    let n = labels.len();
    let widest = labels.iter().map(|l| Ink::size(l).0).fold(0.0, f32::max);
    let fit = ((plot / (widest + 12.0)) as usize).max(1);
    let step = n.div_ceil(fit).max(1);
    (0..n).filter(|i| i % step == 0).collect()
}

/// The values at one x: value first, then the series.
fn series_readout(ink: &Ink, s: &Series, i: usize, bar: bool) -> String {
    let names = s.names();
    let single = s.series.len() == 1;
    let unit = s.unit.as_deref();
    let mut lines = vec![ink.dim(&s.x[i])];
    for (k, se) in s.series.iter().enumerate() {
        let v = se.data[i].map_or("–".to_string(), |v| format(v, unit, false));
        let mut line = format!(
            "{} <b>{}</b>",
            ink.swatch(k, if bar { "■" } else { "▬" }),
            esc(&v)
        );
        if !single {
            line += &format!(" {}", ink.dim(&names[k]));
        }
        lines.push(line);
    }
    if s.is_stacked(bar)
        && let Some(total) = s.stack_totals()[i]
    {
        lines.push(format!(
            "<b>{}</b> {}",
            esc(&format(total, unit, false)),
            ink.dim("total")
        ));
    }
    lines.join("\n")
}

/// A bar from start to end; stacked ones keep a gap from the one below and round only the stack's
/// ends.
struct Segment {
    series: usize,
    index: usize,
    start: f64,
    end: f64,
    outer: bool,
    /// The value (a stack's total) at its tip, on horizontal bars.
    tip: Option<String>,
}

fn segments(s: &Series, bar: bool) -> Vec<Segment> {
    let unit = s.unit.as_deref();
    if !s.is_stacked(bar) {
        return s
            .series
            .iter()
            .enumerate()
            .flat_map(|(k, se)| {
                se.data.iter().enumerate().filter_map(move |(i, v)| {
                    let v = v.filter(|v| *v != 0.0)?;
                    Some(Segment {
                        series: k,
                        index: i,
                        start: 0.0,
                        end: v,
                        outer: true,
                        tip: Some(format(v, unit, false)),
                    })
                })
            })
            .collect();
    }
    let totals = s.stack_totals();
    let mut out = vec![];
    for (i, stack) in s.stack_spans().iter().enumerate() {
        // The total goes at the end of the side it falls on.
        let total = totals[i];
        let positive = total.unwrap_or(0.0) >= 0.0;
        let tip_at = stack
            .iter()
            .rposition(|sp| sp.is_some_and(|(_, e)| (e > 0.0) == positive));
        for (k, span) in stack.iter().enumerate() {
            let Some((start, end)) = *span else { continue };
            let up = end > 0.0;
            let outer = !stack[k + 1..]
                .iter()
                .any(|sp| sp.is_some_and(|(_, e)| (e > 0.0) == up));
            out.push(Segment {
                series: k,
                index: i,
                start,
                end,
                outer,
                tip: if Some(k) == tip_at {
                    total.map(|t| format(t, unit, false))
                } else {
                    None
                },
            });
        }
    }
    out
}

/// The value range bars cover, zero always in it.
fn bar_range(segs: &[Segment]) -> (f64, f64) {
    let lo = segs.iter().map(|s| s.end.min(s.start)).fold(0.0, f64::min);
    let hi = segs.iter().map(|s| s.end.max(s.start)).fold(0.0, f64::max);
    (lo, hi)
}

/// Lines, and columns side by side or stacked.
fn columns(ink: &Ink, s: &Series, bar: bool) {
    let n = s.x.len();
    let single = s.series.len() == 1;
    let unit = s.unit.as_deref();
    let top = if single { 8.0 } else { LEGEND + 8.0 };
    if !single {
        ink.legend(&s.names(), if bar { Key::Bar } else { Key::Line });
    }
    let segs = if bar { segments(s, true) } else { vec![] };
    let (lo, hi) = if bar {
        bar_range(&segs)
    } else {
        let vs = s.series.iter().flat_map(|se| se.data.iter().flatten());
        vs.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
            (lo.min(*v), hi.max(*v))
        })
    };
    let (t, labels, widest) = ticks(ink, lo, hi, unit, 4);
    let (y0, y1) = (t[0], *t.last().unwrap_or(&t[0]));
    let left = widest + 8.0;
    // One line gets its last value beside its end.
    let last_value = (!bar && single).then(|| {
        let v = s.series[0]
            .data
            .iter()
            .rev()
            .flatten()
            .next()
            .copied()
            .unwrap_or(0.0);
        ink.text(&format(v, unit, false), false)
    });
    let right = last_value.as_ref().map_or(8.0, |l| Ink::size(l).0 + 14.0);
    let pw = (ink.width - left - right).max(20.0);
    let y = |v: f64| top + PLOT - ((v - y0) / (y1 - y0).max(f64::EPSILON)) as f32 * PLOT;
    let band = pw / n as f32;
    let x = |i: usize| {
        if bar {
            left + band * (i as f32 + 0.5)
        } else if n == 1 {
            left + pw / 2.0
        } else {
            left + pw * i as f32 / (n - 1) as f32
        }
    };
    for (v, l) in t.iter().zip(&labels) {
        let (w, h) = Ink::size(l);
        ink.rule_y(y(*v), left, left + pw, &ink.grid());
        ink.put(l, left - 6.0 - w, y(*v) - h / 2.0, &ink.secondary());
    }
    let x_labels: Vec<pango::Layout> = s.x.iter().map(|x| ink.text(&cut(x, 12), false)).collect();
    for i in shown_labels(&x_labels, pw) {
        let l = &x_labels[i];
        let w = Ink::size(l).0;
        let lx = (x(i) - w / 2.0).clamp(0.0, (ink.width - w).max(0.0));
        ink.put(l, lx, top + PLOT + 6.0, &ink.secondary());
    }
    let hovered = ink.hover.and_then(|(hx, hy)| {
        if hx < left - 4.0 || hx > left + pw + 4.0 || hy > top + PLOT + AXIS {
            return None;
        }
        let i = if bar {
            ((hx - left) / band).floor()
        } else if n == 1 {
            0.0
        } else {
            ((hx - left) / pw * (n - 1) as f32).round()
        };
        Some((i.max(0.0) as usize).min(n - 1))
    });

    if bar {
        let k = if s.is_stacked(true) {
            1
        } else {
            s.series.len()
        };
        let group = (band * 0.72).min((24 * k + 2 * (k - 1)) as f32);
        let w = ((group - (2 * (k - 1)) as f32) / k as f32).clamp(1.0, 24.0);
        let total = k as f32 * w + (2 * (k - 1)) as f32;
        for b in &segs {
            let slot = if k == 1 { 0 } else { b.series };
            let bx = x(b.index) - total / 2.0 + slot as f32 * (w + 2.0);
            let up = b.end > 0.0;
            let mut start = y(b.start);
            if b.start != 0.0 {
                start += if up { -2.0 } else { 2.0 };
            }
            let end = y(b.end);
            let (top_y, h) = if up {
                (end, start - end)
            } else {
                (start, end - start)
            };
            if h < 1.0 {
                continue;
            }
            let c = alpha(
                &ink.colors[b.series.min(2)],
                if hovered.is_none_or(|i| i == b.index) {
                    1.0
                } else {
                    0.45
                },
            );
            let corners = if !b.outer {
                [false; 4]
            } else if up {
                [true, true, false, false]
            } else {
                [false, false, true, true]
            };
            ink.bar(bx, top_y, w, h, corners, &c);
        }
        ink.rule_y(y(0.0), left, left + pw, &ink.zero());
    } else {
        for (k, se) in s.series.iter().enumerate() {
            let c = &ink.colors[k.min(2)];
            let mut run: Vec<(f32, f32)> = vec![];
            let flush = |run: &mut Vec<(f32, f32)>| {
                match run.len() {
                    0 => {}
                    1 => ink.circle(run[0].0, run[0].1, 2.5, c),
                    _ => ink.line(run, 2.0, c),
                }
                run.clear();
            };
            for (i, v) in se.data.iter().enumerate() {
                match v {
                    Some(v) => run.push((x(i), y(*v))),
                    None => flush(&mut run),
                }
            }
            flush(&mut run);
        }
        if let Some(i) = hovered {
            ink.rule_x(x(i), top, top + PLOT, &alpha(&ink.fg, 0.4));
        }
        // Pointed at, every line's value there; otherwise each line's last value.
        for (k, se) in s.series.iter().enumerate() {
            let at = match hovered {
                Some(i) => se.data[i].map(|v| (i, v)),
                None => se
                    .data
                    .iter()
                    .enumerate()
                    .rev()
                    .find_map(|(i, v)| v.map(|v| (i, v))),
            };
            if let Some((i, v)) = at {
                ink.dot(x(i), y(v), &ink.colors[k.min(2)]);
                if let (Some(l), None) = (&last_value, hovered) {
                    let h = Ink::size(l).1;
                    ink.put(l, x(i) + 9.0, y(v) - h / 2.0, &ink.secondary());
                }
            }
        }
    }
    if let (Some(i), Some((hx, _))) = (hovered, ink.hover) {
        ink.readout(&series_readout(ink, s, i, bar), hx, top);
    }
}

fn row_height(s: &Series, bar: bool) -> f32 {
    let k = if s.is_stacked(bar) { 1 } else { s.series.len() };
    let thick = if k == 1 { 14.0 } else { 10.0 };
    k as f32 * thick + (2 * (k - 1)) as f32 + 10.0
}

/// A label on the left, cut in the middle to fit `max`.
fn row_label(ink: &Ink, text: &str, max: f32) -> pango::Layout {
    let l = ink.text(text, false);
    l.set_width((max * pango::SCALE as f32) as i32);
    l.set_ellipsize(pango::EllipsizeMode::Middle);
    l
}

/// Horizontal bars: one row per x, its bars side by side, the value at each tip.
fn rows(ink: &Ink, s: &Series) {
    let single = s.series.len() == 1;
    let top = if single { 0.0 } else { LEGEND };
    if !single {
        ink.legend(&s.names(), Key::Bar);
    }
    let k = if s.is_stacked(true) {
        1
    } else {
        s.series.len()
    };
    let thick = if k == 1 { 14.0 } else { 10.0 };
    let rh = row_height(s, true);
    let segs = segments(s, true);
    let (lo, hi) = bar_range(&segs);
    let labels: Vec<pango::Layout> = s.x.iter().map(|x| row_label(ink, x, 120.0)).collect();
    let label_w = labels
        .iter()
        .map(|l| Ink::size(l).0)
        .fold(0.0, f32::max)
        .min(120.0)
        + 10.0;
    let tips: Vec<Option<pango::Layout>> = segs
        .iter()
        .map(|b| b.tip.as_ref().map(|t| ink.text(t, false)))
        .collect();
    let tip_w = tips
        .iter()
        .flatten()
        .map(|l| Ink::size(l).0)
        .fold(0.0, f32::max)
        + 6.0;
    let left = label_w + if lo < 0.0 { tip_w } else { 0.0 };
    let pw = (ink.width - left - if hi > 0.0 { tip_w } else { 0.0 }).max(20.0);
    let span = (hi - lo).max(f64::EPSILON);
    let x = |v: f64| left + ((v - lo) / span) as f32 * pw;
    let hovered = ink.hover.and_then(|(_, hy)| {
        let r = ((hy - top) / rh).floor();
        (r >= 0.0 && (r as usize) < s.x.len()).then_some(r as usize)
    });
    for (i, l) in labels.iter().enumerate() {
        let h = Ink::size(l).1;
        ink.put(l, 0.0, top + rh * (i as f32 + 0.5) - h / 2.0, &ink.fg);
    }
    for (b, tip) in segs.iter().zip(&tips) {
        let slot = if k == 1 { 0 } else { b.series };
        let by = top + rh * b.index as f32 + 5.0 + slot as f32 * (thick + 2.0);
        let up = b.end > 0.0;
        let mut start = x(b.start);
        if b.start != 0.0 {
            start += if up { 2.0 } else { -2.0 };
        }
        let end = x(b.end);
        let (bx, w) = if up {
            (start, end - start)
        } else {
            (end, start - end)
        };
        let shown = hovered.is_none_or(|i| i == b.index);
        if w >= 1.0 {
            let c = alpha(&ink.colors[b.series.min(2)], if shown { 1.0 } else { 0.45 });
            let corners = if !b.outer {
                [false; 4]
            } else if up {
                [false, true, true, false]
            } else {
                [true, false, false, true]
            };
            ink.bar(bx, by, w, thick, corners, &c);
        }
        if let Some(l) = tip {
            let (tw, th) = Ink::size(l);
            let tx = if up { end + 4.0 } else { end - 4.0 - tw };
            ink.put(l, tx, by + thick / 2.0 - th / 2.0, &ink.secondary());
        }
    }
    ink.rule_x(x(0.0), top, top + rh * s.x.len() as f32, &ink.zero());
    if let (Some(i), Some((hx, _))) = (hovered, ink.hover) {
        ink.readout(
            &series_readout(ink, s, i, true),
            hx,
            top + rh * (i as f32 + 1.0),
        );
    }
}

/// Points on two measured axes. A few points are named beside them; pointing reads out the nearest.
fn scatter(ink: &Ink, s: &Scatter) {
    let single = s.series.len() == 1;
    let names = s.names();
    let mut top = 0.0;
    if !single {
        ink.legend(&names, Key::Point);
        top += LEGEND;
    }
    let axis_name = |n: &Option<String>| {
        n.as_deref()
            .filter(|n| !n.is_empty())
            .map(|n| ink.text(n, false))
    };
    if let Some(l) = axis_name(&s.y_name) {
        ink.put(&l, 0.0, top, &ink.secondary());
        top += 18.0;
    }
    top += 8.0;
    let points: Vec<(usize, &chart::Point)> = s
        .series
        .iter()
        .enumerate()
        .flat_map(|(k, se)| se.points.iter().map(move |p| (k, p)))
        .collect();
    let range = |f: fn(&chart::Point) -> f64| {
        points
            .iter()
            .map(|(_, p)| f(p))
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
                (lo.min(v), hi.max(v))
            })
    };
    let (ylo, yhi) = range(|p| p.y);
    let (yt, ylabels, widest) = ticks(ink, ylo, yhi, s.y_unit.as_deref(), 4);
    let left = widest + 8.0;
    let pw = (ink.width - left - 12.0).max(20.0);
    let (xlo, xhi) = range(|p| p.x);
    let (xt, xlabels, _) = ticks(
        ink,
        xlo,
        xhi,
        s.x_unit.as_deref(),
        ((pw / 80.0) as usize).max(2),
    );
    let ph = 190.0;
    let (x0, x1) = (xt[0], *xt.last().unwrap_or(&xt[0]));
    let (y0, y1) = (yt[0], *yt.last().unwrap_or(&yt[0]));
    let x = |v: f64| left + ((v - x0) / (x1 - x0).max(f64::EPSILON)) as f32 * pw;
    let y = |v: f64| top + ph - ((v - y0) / (y1 - y0).max(f64::EPSILON)) as f32 * ph;
    for (v, l) in yt.iter().zip(&ylabels) {
        let (w, h) = Ink::size(l);
        ink.rule_y(y(*v), left, left + pw, &ink.grid());
        ink.put(l, left - 6.0 - w, y(*v) - h / 2.0, &ink.secondary());
    }
    for (v, l) in xt.iter().zip(&xlabels) {
        let w = Ink::size(l).0;
        ink.rule_x(x(*v), top, top + ph, &ink.grid());
        let lx = (x(*v) - w / 2.0).clamp(0.0, (ink.width - w).max(0.0));
        ink.put(l, lx, top + ph + 4.0, &ink.secondary());
    }
    if let Some(l) = axis_name(&s.x_name) {
        let w = Ink::size(&l).0;
        ink.put(&l, ink.width - w, top + ph + AXIS, &ink.secondary());
    }
    // The nearest point along x, with any others at that same x.
    let picked: Vec<usize> = ink
        .hover
        .filter(|(hx, hy)| *hx >= left - 8.0 && *hy <= top + ph + AXIS)
        .and_then(|(hx, _)| {
            let near = points
                .iter()
                .min_by(|a, b| (x(a.1.x) - hx).abs().total_cmp(&(x(b.1.x) - hx).abs()))?;
            Some(
                (0..points.len())
                    .filter(|i| points[*i].1.x == near.1.x)
                    .collect(),
            )
        })
        .unwrap_or_default();
    if let Some(i) = picked.first() {
        ink.rule_x(x(points[*i].1.x), top, top + ph, &alpha(&ink.fg, 0.4));
    }
    // Past a dozen points their names would pile up, so they're left to the readout.
    let named = points.len() <= 12;
    for (i, (k, p)) in points.iter().enumerate() {
        let (px, py) = (x(p.x), y(p.y));
        let c = alpha(
            &ink.colors[(*k).min(2)],
            if picked.is_empty() || picked.contains(&i) {
                0.9
            } else {
                0.35
            },
        );
        // Shape as well as colour, so series don't rest on colour alone.
        match k {
            0 => ink.dot(px, py, &c),
            1 => {
                ink.bar(px - 5.5, py - 5.5, 11.0, 11.0, [true; 4], &ink.bubble());
                ink.bar(px - 3.5, py - 3.5, 7.0, 7.0, [false; 4], &c);
            }
            _ => {
                let b = gsk::PathBuilder::new();
                b.move_to(px, py - 5.0);
                b.line_to(px + 5.0, py);
                b.line_to(px, py + 5.0);
                b.line_to(px - 5.0, py);
                b.close();
                let path = b.to_path();
                let ring = gsk::Stroke::new(4.0);
                ink.snap().append_stroke(&path, &ring, &ink.bubble());
                ink.snap().append_fill(&path, gsk::FillRule::Winding, &c);
            }
        }
        if named && let Some(label) = &p.label {
            let l = ink.text(label, false);
            let (w, h) = Ink::size(&l);
            ink.put(
                &l,
                (px - w / 2.0).clamp(0.0, (ink.width - w).max(0.0)),
                py - 7.0 - h,
                &ink.secondary(),
            );
        }
    }
    if let (Some(first), Some((hx, _))) = (picked.first(), ink.hover) {
        let _ = first;
        let mut lines = vec![];
        let value = |v: f64, unit: &Option<String>, name: &Option<String>| {
            let mut t = format!("<b>{}</b>", esc(&format(v, unit.as_deref(), false)));
            if let Some(n) = name.as_deref().filter(|n| !n.is_empty()) {
                t += &format!(" {}", ink.dim(n));
            }
            t
        };
        for i in picked.iter().take(4) {
            let (k, p) = points[*i];
            if let Some(name) = p.label.clone().or((!single).then(|| names[k].clone())) {
                lines.push(ink.dim(&name));
            }
            let mut line = String::new();
            if !single {
                line += &format!("{} ", ink.swatch(k, "●"));
            }
            line += &format!(
                "{}  {}",
                value(p.x, &s.x_unit, &s.x_name),
                value(p.y, &s.y_unit, &s.y_name)
            );
            lines.push(line);
        }
        if picked.len() > 4 {
            lines.push(ink.dim(&format!("and {} more", picked.len() - 4)));
        }
        ink.readout(&lines.join("\n"), hx, top);
    }
}

/// A span from low to high for each row, its mark a dot inside; point at a row for its numbers.
fn ranges(ink: &Ink, r: &Ranges) {
    let unit = r.unit.as_deref();
    let mark_name = r
        .mark_name
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or("Mark".into());
    // The span is the palette's first colour, lighter, so the mark on it stands out in the same hue.
    let span_c = alpha(&ink.colors[0], 0.45);
    let mut top = 0.0;
    if r.rows.iter().any(|row| row.mark.is_some()) {
        ink.bar(0.0, 6.0, 14.0, 8.0, [true; 4], &span_c);
        let l = ink.text("Low to high", false);
        let (w, h) = Ink::size(&l);
        ink.put(&l, 19.0, 10.0 - h / 2.0, &ink.secondary());
        let mx = 19.0 + w + 18.0;
        ink.dot(mx, 10.0, &ink.colors[0]);
        let l = ink.text(&mark_name, false);
        ink.put(&l, mx + 10.0, 10.0 - h / 2.0, &ink.secondary());
        top = LEGEND;
    }
    let labels: Vec<pango::Layout> = r
        .rows
        .iter()
        .map(|row| row_label(ink, &row.label, 120.0))
        .collect();
    let left = labels
        .iter()
        .map(|l| Ink::size(l).0)
        .fold(0.0, f32::max)
        .min(120.0)
        + 12.0;
    let lo = r
        .rows
        .iter()
        .map(|row| row.low)
        .fold(f64::INFINITY, f64::min);
    let hi = r
        .rows
        .iter()
        .map(|row| row.high)
        .fold(f64::NEG_INFINITY, f64::max);
    let (t, tick_labels, _) = ticks(ink, lo, hi, unit, 4);
    let (x0, x1) = (t[0], *t.last().unwrap_or(&t[0]));
    let pw = (ink.width - left - 12.0).max(20.0);
    let x = |v: f64| left + ((v - x0) / (x1 - x0).max(f64::EPSILON)) as f32 * pw;
    let bottom = top + r.rows.len() as f32 * 24.0;
    for (v, l) in t.iter().zip(&tick_labels) {
        let w = Ink::size(l).0;
        ink.rule_x(x(*v), top, bottom, &ink.grid());
        let lx = (x(*v) - w / 2.0).clamp(0.0, (ink.width - w).max(0.0));
        ink.put(l, lx, bottom + 4.0, &ink.secondary());
    }
    let hovered = ink.hover.and_then(|(_, hy)| {
        let i = ((hy - top) / 24.0).floor();
        (i >= 0.0 && (i as usize) < r.rows.len()).then_some(i as usize)
    });
    for (i, (row, l)) in r.rows.iter().zip(&labels).enumerate() {
        let cy = top + 24.0 * i as f32 + 12.0;
        let h = Ink::size(l).1;
        ink.put(l, 0.0, cy - h / 2.0, &ink.fg);
        let shown = hovered.is_none_or(|h| h == i);
        let s = ink.snap();
        if !shown {
            s.push_opacity(0.45);
        }
        let (a, b) = (x(row.low), x(row.high));
        if b - a >= 1.0 {
            ink.bar(a, cy - 5.0, b - a, 10.0, [true; 4], &span_c);
        }
        // A row with no width still shows, as its dot.
        if let Some(m) = row.mark.or((row.low == row.high).then_some(row.low)) {
            ink.dot(x(m), cy, &ink.colors[0]);
        }
        if !shown {
            s.pop();
        }
    }
    if let (Some(i), Some((hx, _))) = (hovered, ink.hover) {
        let row = &r.rows[i];
        let mut lines = vec![
            ink.dim(&row.label),
            format!(
                "<b>{} – {}</b>",
                esc(&format(row.low, unit, false)),
                esc(&format(row.high, unit, false))
            ),
        ];
        if let Some(m) = row.mark {
            lines.push(format!(
                "<b>{}</b> {}",
                esc(&format(m, unit, false)),
                ink.dim(&mark_name)
            ));
        }
        ink.readout(&lines.join("\n"), hx, top + 24.0 * (i as f32 + 1.0));
    }
}

/// Options against criteria, the value in every cell, each column shaded in one hue from its worst
/// (light) to its best (dark).
struct MatrixGrid<'a> {
    m: &'a Matrix,
    heads: Vec<pango::Layout>,
    labels: Vec<pango::Layout>,
    cells: Vec<Vec<pango::Layout>>,
    label_w: f32,
    head_h: f32,
    widths: Vec<f32>,
    heights: Vec<f32>,
}

const GAP: f32 = 3.0;

impl<'a> MatrixGrid<'a> {
    fn new(ink: &Ink, m: &'a Matrix) -> MatrixGrid<'a> {
        let two_lines = |l: &pango::Layout, w: f32| {
            l.set_width((w * pango::SCALE as f32) as i32);
            l.set_wrap(pango::WrapMode::WordChar);
            l.set_height(-2);
            l.set_ellipsize(pango::EllipsizeMode::End);
        };
        let heads: Vec<pango::Layout> = m
            .columns
            .iter()
            .map(|c| {
                let l = ink.text(&c.name, true);
                if Ink::size(&l).0 > 96.0 {
                    two_lines(&l, 96.0);
                }
                l.set_alignment(pango::Alignment::Right);
                l
            })
            .collect();
        let labels: Vec<pango::Layout> = m
            .rows
            .iter()
            .map(|r| {
                let l = ink.text(r, false);
                if Ink::size(&l).0 > 120.0 {
                    two_lines(&l, 120.0);
                }
                l
            })
            .collect();
        let cells: Vec<Vec<pango::Layout>> = m
            .values
            .iter()
            .map(|row| {
                row.iter()
                    .zip(&m.columns)
                    .map(|(v, c)| {
                        ink.text(
                            &v.map_or("–".into(), |v| format(v, c.unit.as_deref(), false)),
                            false,
                        )
                    })
                    .collect()
            })
            .collect();
        let label_w = labels.iter().map(|l| Ink::size(l).0).fold(0.0, f32::max) + 8.0;
        let head_h = heads.iter().map(|l| Ink::size(l).1).fold(0.0, f32::max) + 4.0;
        let widths = (0..m.columns.len())
            .map(|c| {
                let cell = cells.iter().map(|r| Ink::size(&r[c]).0).fold(0.0, f32::max);
                (cell + 16.0).max(Ink::size(&heads[c]).0 + 16.0).max(52.0)
            })
            .collect();
        let heights = (0..m.rows.len())
            .map(|r| {
                let cell = cells[r].iter().map(|l| Ink::size(l).1).fold(0.0, f32::max);
                (cell + 12.0).max(Ink::size(&labels[r]).1)
            })
            .collect();
        MatrixGrid {
            m,
            heads,
            labels,
            cells,
            label_w,
            head_h,
            widths,
            heights,
        }
    }

    fn width(&self) -> f32 {
        self.label_w + self.widths.iter().map(|w| w + GAP).sum::<f32>()
    }

    fn height(&self) -> f32 {
        self.head_h + self.heights.iter().map(|h| h + GAP).sum::<f32>()
    }

    fn draw(&self, ink: &Ink) {
        // One hue for every column, so a shade only ever means better.
        let hue = ink.colors[1];
        let mut x = self.label_w + GAP;
        for (c, l) in self.heads.iter().enumerate() {
            let (w, h) = Ink::size(l);
            ink.put(
                l,
                x + self.widths[c] - 8.0 - w,
                self.head_h - 2.0 - h,
                &ink.secondary(),
            );
            x += self.widths[c] + GAP;
        }
        let mut y = self.head_h + GAP;
        for (r, label) in self.labels.iter().enumerate() {
            let rh = self.heights[r];
            let lh = Ink::size(label).1;
            ink.put(label, 0.0, y + rh / 2.0 - lh / 2.0, &ink.fg);
            let mut x = self.label_w + GAP;
            for (c, cell) in self.cells[r].iter().enumerate() {
                let cw = self.widths[c];
                // At most half the hue under the text, so it reads in either mode.
                if let Some(shade) = self.m.shade(r, c) {
                    ink.bar(
                        x,
                        y,
                        cw,
                        rh,
                        [true; 4],
                        &alpha(&hue, (0.08 + 0.5 * shade) as f32),
                    );
                }
                let (w, h) = Ink::size(cell);
                let color = if self.m.values[r][c].is_some() {
                    ink.fg
                } else {
                    ink.secondary()
                };
                ink.put(cell, x + cw - 8.0 - w, y + rh / 2.0 - h / 2.0, &color);
                x += cw + GAP;
            }
            y += rh + GAP;
        }
    }
}

/// Dated events along one axis, a row per lane: dots for dates, bars for spans, each named where its
/// name has room; point for the one nearest.
fn timeline(ink: &Ink, t: &Timeline) {
    let lanes = t.lanes();
    // Events all in no lane are one row, with no lane names.
    let unnamed = lanes == [""];
    let lane_labels: Vec<pango::Layout> = lanes.iter().map(|l| row_label(ink, l, 90.0)).collect();
    let left = if unnamed {
        0.0
    } else {
        lane_labels
            .iter()
            .map(|l| Ink::size(l).0)
            .fold(0.0, f32::max)
            .min(90.0)
            + 10.0
    };
    // (lane, first day, the day after the last) for each event.
    let events: Vec<(usize, f64, Option<f64>)> = t
        .events
        .iter()
        .map(|e| {
            let start = chart::date_range(&e.date).map_or(0, |r| r.0) as f64;
            let end = e
                .end
                .as_deref()
                .and_then(chart::date_range)
                .map(|r| (r.1 + 1) as f64);
            let lane = lanes
                .iter()
                .position(|l| *l == e.lane.clone().unwrap_or_default())
                .unwrap_or(0);
            (lane, start, end)
        })
        .collect();
    let lo = events.iter().map(|e| e.1).fold(f64::INFINITY, f64::min);
    let hi = events
        .iter()
        .map(|e| e.2.unwrap_or(e.1))
        .fold(f64::NEG_INFINITY, f64::max);
    // Room either side so the end dots aren't cut in half.
    let pad = ((hi - lo) * 0.04).max(14.0);
    let (d0, d1) = (lo - pad, hi + pad);
    let pw = (ink.width - left).max(20.0);
    let x = |d: f64| left + ((d - d0) / (d1 - d0)) as f32 * pw;
    let bottom = lanes.len() as f32 * 40.0;
    for (d, text) in date_ticks(d0, d1) {
        let l = ink.text(&text, false);
        let w = Ink::size(&l).0;
        ink.rule_x(x(d), 0.0, bottom, &ink.grid());
        ink.put(
            &l,
            (x(d) - w / 2.0).clamp(left, (ink.width - w).max(left)),
            bottom + 6.0,
            &ink.secondary(),
        );
    }
    if !unnamed {
        for (i, l) in lane_labels.iter().enumerate() {
            let h = Ink::size(l).1;
            ink.put(l, 0.0, 40.0 * i as f32 + 26.0 - h / 2.0, &ink.secondary());
        }
    }
    let picked = ink
        .hover
        .filter(|(hx, hy)| *hx >= left && *hy <= bottom + 28.0)
        .and_then(|(hx, _)| {
            let at = d0 + ((hx - left) / pw) as f64 * (d1 - d0);
            let distance = |e: &(usize, f64, Option<f64>)| {
                let last = e.2.unwrap_or(e.1);
                if at < e.1 {
                    e.1 - at
                } else {
                    (at - last).max(0.0)
                }
            };
            (0..events.len()).min_by(|a, b| distance(&events[*a]).total_cmp(&distance(&events[*b])))
        });
    // In each lane, one whose name would run into the last one named is left to the readout.
    let mut order: Vec<usize> = (0..events.len()).collect();
    order.sort_by(|a, b| events[*a].1.total_cmp(&events[*b].1));
    let mut reach: HashMap<usize, f32> = HashMap::new();
    for i in order {
        let (lane, start, end) = events[i];
        let cy = 40.0 * lane as f32 + 26.0;
        let shown = picked.is_none_or(|p| p == i);
        let s = ink.snap();
        if !shown {
            s.push_opacity(0.45);
        }
        match end {
            Some(end) => {
                let (a, b) = (x(start), x(end));
                ink.bar(
                    a,
                    cy - 4.0,
                    (b - a).max(8.0),
                    8.0,
                    [true; 4],
                    &ink.colors[0],
                );
            }
            None => ink.dot(x(start), cy, &ink.colors[0]),
        }
        let name = ink.text(&t.events[i].label, false);
        let (w, h) = Ink::size(&name);
        let nx = x(start).min(ink.width - w).max(left);
        if nx >= *reach.get(&lane).unwrap_or(&f32::NEG_INFINITY) {
            ink.put(&name, nx, cy - 8.0 - h, &ink.secondary());
            reach.insert(lane, nx + w + 8.0);
        }
        if !shown {
            s.pop();
        }
    }
    if let (Some(i), Some((hx, _))) = (picked, ink.hover) {
        let e = &t.events[i];
        let (_, start, end) = events[i];
        let at = d0 + ((hx - left) / pw) as f64 * (d1 - d0);
        let rx = x(at.clamp(start, end.unwrap_or(start)));
        ink.rule_x(rx, 0.0, bottom, &alpha(&ink.fg, 0.4));
        let mut lines = vec![
            format!("<b>{}</b>", esc(&e.label)),
            ink.dim(&chart::when(e)),
        ];
        if let Some(lane) = e.lane.as_deref().filter(|l| !l.is_empty()) {
            lines.push(ink.dim(lane));
        }
        ink.readout(&lines.join("\n"), rx, 0.0);
    }
}

/// About four ticks along a span of days: years past three years, months past two, otherwise days.
fn date_ticks(d0: f64, d1: f64) -> Vec<(f64, String)> {
    let span = d1 - d0;
    let (y0, m0, _) = chart::civil(d0.ceil() as i64);
    let (y1, ..) = chart::civil(d1.floor() as i64);
    let mut out = vec![];
    if span > 3.0 * 365.0 {
        let years = (y1 - y0 + 1).max(1);
        let step = [1, 2, 5, 10, 20, 50, 100]
            .into_iter()
            .find(|k| years / k <= 5)
            .unwrap_or(100);
        let mut y = y0.div_euclid(step) * step;
        while y <= y1 {
            let d = chart::date_range(&format!("{y:04}")).map_or(0, |r| r.0) as f64;
            if d >= d0 && d <= d1 {
                out.push((d, y.to_string()));
            }
            y += step;
        }
    } else if span > 62.0 {
        let months = (span / 30.4).ceil() as i64;
        let step = [1, 2, 3, 6, 12]
            .into_iter()
            .find(|k| months / k <= 5)
            .unwrap_or(12);
        let (mut y, mut m) = (y0, m0);
        loop {
            let d = chart::date_range(&format!("{y:04}-{m:02}")).map_or(0, |r| r.0) as f64;
            if d > d1 {
                break;
            }
            if d >= d0 && (m - 1) % step == 0 {
                let first = out.is_empty();
                let text = if m == 1 || first {
                    format!("{} {y}", chart::month_name(m))
                } else {
                    chart::month_name(m).to_string()
                };
                out.push((d, text));
            }
            m += 1;
            if m > 12 {
                m = 1;
                y += 1;
            }
        }
    } else {
        let step = [1, 2, 7, 14, 28]
            .into_iter()
            .find(|k| span / (*k as f64) <= 5.0)
            .unwrap_or(28);
        let mut d = (d0.ceil() as i64).div_euclid(step) * step;
        while (d as f64) <= d1 {
            if d as f64 >= d0 {
                let (_, m, day) = chart::civil(d);
                out.push((d as f64, format!("{day} {}", chart::month_name(m))));
            }
            d += step;
        }
    }
    out
}
