// Chart blocks in the web's look (apps/web/src/charts): plots on a canvas, with a readout of what's under
// the pointer; tables, meters and cards as widgets.
use std::collections::HashMap;

use iced::alignment::Vertical;
use iced::widget::canvas::{self, Frame, Geometry, LineDash, Path, Stroke, Text};
use iced::widget::text::Alignment as Align;
use iced::widget::{Space, button, column, container, image, responsive, row, scrollable, text};
use iced::{Alignment, Border, Color, Element, Length, Point, Rectangle, Renderer, Size, Theme, mouse};

use super::theme::{self, Colors, FS_MD, FS_SM, FS_XS, PILL, R_MD, R_XS, SP, SP_MD, SP_SM, alpha};
use super::widgets::tone;
use crate::core::chart::{self as spec, ChartSpec, Kind, Side, format, nice_ticks};

/// A chart's height, and a pending one's while its block streams in.
pub const HEIGHT: f32 = 170.0;
const WIDTH: f32 = 560.0;
const TOP: f32 = 8.0;
const AXIS_H: f32 = 22.0;
const PLOT_H: f32 = HEIGHT - TOP - AXIS_H;
const LINE_H: f32 = 16.0;

/// What a chart needs from the page: listing photos the brain has fetched, and opening a link.
pub struct Ctx<'a, M> {
    pub dark: bool,
    pub photo: &'a dyn Fn(&str) -> Option<image::Handle>,
    pub open: fn(String) -> M,
}

impl<M> Clone for Ctx<'_, M> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<M> Copy for Ctx<'_, M> {}

pub fn view<'a, M: Clone + 'a>(chart: &'a ChartSpec, ctx: Ctx<'a, M>) -> Element<'a, M> {
    let (legend, body): (Vec<(String, Mark, Ink)>, Element<'a, M>) = match &chart.kind {
        Kind::Line(s) | Kind::Bar(s) => {
            let bar = matches!(chart.kind, Kind::Bar(_));
            let mark = if bar { Mark::Swatch } else { Mark::Key };
            let legend = if s.series.len() > 1 {
                s.names().into_iter().enumerate().map(|(i, n)| (n, mark, Ink::Series(i))).collect()
            } else {
                vec![]
            };
            let body = if bar && s.horizontal { plot(Rows { s }) } else { plot(Columns { s, bar }) };
            (legend, body)
        }
        Kind::Scatter(s) => {
            let legend = if s.series.len() > 1 {
                s.names().into_iter().enumerate().map(|(i, n)| (n, Mark::Point, Ink::Series(i))).collect()
            } else {
                vec![]
            };
            (legend, plot(Scatter { s }))
        }
        Kind::Range(r) => {
            let legend = if r.rows.iter().any(|row| row.mark.is_some()) {
                vec![(r.mark_name.clone().unwrap_or_else(|| "mark".into()), Mark::Point, Ink::Text)]
            } else {
                vec![]
            };
            (legend, plot(Range { r }))
        }
        Kind::Timeline(t) => (vec![], plot(Timeline { t })),
        Kind::Calendar(c) => (vec![], plot(Calendar::new(c))),
        Kind::Treemap(t) => (vec![], plot(Treemap { t })),
        Kind::Offers(o) => {
            let legend = vec![
                ("You".to_string(), Mark::Key, Ink::Series(0)),
                (o.them_name().to_string(), Mark::Key, Ink::Series(1)),
            ];
            (legend, plot(Offers { o }))
        }
        Kind::Matrix(m) => (vec![], matrix(m)),
        Kind::Compare(c) => (vec![], compare(c)),
        Kind::Meter(m) => (vec![], meter(m)),
        Kind::Listings(l) => (vec![], listings(l, ctx)),
        Kind::Gallery(g) => (vec![], gallery(g, ctx)),
    };
    let wide = matches!(chart.kind, Kind::Listings(_) | Kind::Gallery(_));
    column![]
        .push(chart.title.as_deref().filter(|t| !t.is_empty()).map(|t| text(t).size(FS_MD).font(theme::SEMIBOLD)))
        .push((!legend.is_empty()).then(|| legend_row(legend)))
        .push(body)
        .spacing(SP_SM)
        .max_width(if wide { f32::INFINITY } else { WIDTH })
        .into()
}

pub fn pending<'a, M: 'a>() -> Element<'a, M> {
    container(Space::new())
        .width(Length::Fill)
        .max_width(WIDTH)
        .height(HEIGHT)
        .style(|t: &Theme| {
            let c = theme::colors(t);
            container::Style {
                background: Some(grid(c).into()),
                border: Border { radius: R_MD.into(), ..Border::default() },
                ..Default::default()
            }
        })
        .into()
}

// Legend

#[derive(Clone, Copy)]
enum Mark {
    Key,
    Swatch,
    Point,
}

#[derive(Clone, Copy)]
enum Ink {
    Series(usize),
    Text,
}

impl Ink {
    fn of(self, c: &Colors) -> Color {
        match self {
            Ink::Series(i) => c.series[i.min(2)],
            Ink::Text => c.text,
        }
    }
}

fn legend_row<'a, M: 'a>(items: Vec<(String, Mark, Ink)>) -> Element<'a, M> {
    let mut r = row![].spacing(SP_MD + 4.0);
    for (name, mark, ink) in items {
        let (w, h, radius) = match mark {
            Mark::Key => (12.0, 2.0, 1.0),
            Mark::Swatch => (8.0, 8.0, 2.0),
            Mark::Point => (8.0, 8.0, 4.0),
        };
        let swatch = container(Space::new()).width(w).height(h).style(move |t: &Theme| container::Style {
            background: Some(ink.of(theme::colors(t)).into()),
            border: Border { radius: radius.into(), ..Border::default() },
            ..Default::default()
        });
        r = r.push(
            row![swatch, text(name).size(FS_XS).style(tone(|c| c.text_2))].spacing(SP_SM).align_y(Alignment::Center),
        );
    }
    r.wrap().vertical_spacing(SP / 2.0).into()
}

// The canvas

/// A plot drawn for a width: its height, which item is under a point, and its drawing with one picked.
trait Plot {
    fn height(&self, w: f32) -> f32;
    fn pick(&self, w: f32, p: Point) -> Option<usize>;
    fn draw(&self, f: &mut Frame, c: &Colors, at: Option<usize>);
}

#[derive(Default)]
struct Hover(Option<usize>);

struct Program<P>(P);

impl<M, P: Plot> canvas::Program<M> for Program<P> {
    type State = Hover;

    fn update(
        &self,
        state: &mut Hover,
        event: &canvas::Event,
        bounds: Rectangle,
        cursor: mouse::Cursor,
    ) -> Option<canvas::Action<M>> {
        let canvas::Event::Mouse(mouse::Event::CursorMoved { .. } | mouse::Event::CursorLeft) = event else {
            return None;
        };
        let at = cursor.position_in(bounds).and_then(|p| self.0.pick(bounds.width, p));
        if at == state.0 {
            return None;
        }
        state.0 = at;
        Some(canvas::Action::request_redraw())
    }

    fn draw(
        &self,
        state: &Hover,
        renderer: &Renderer,
        theme: &Theme,
        bounds: Rectangle,
        _: mouse::Cursor,
    ) -> Vec<Geometry> {
        let mut f = Frame::new(renderer, bounds.size());
        self.0.draw(&mut f, theme::colors(theme), state.0);
        vec![f.into_geometry()]
    }
}

fn plot<'a, M: 'a, P: Plot + Clone + 'a>(p: P) -> Element<'a, M> {
    responsive(move |size| {
        let w = size.width.clamp(80.0, WIDTH);
        let h = p.height(w);
        iced::widget::canvas(Program(p.clone())).width(w).height(h).into()
    })
    .height(Length::Shrink)
    .into()
}

/// Text can't be measured on a canvas, so its width is guessed from its length.
fn est(s: &str, size: f32) -> f32 {
    s.chars().count() as f32 * 0.55 * size
}

fn cut_to(s: &str, cut: usize) -> String {
    if s.chars().count() > cut {
        format!("{}…", s.chars().take(cut.max(2) - 1).collect::<String>())
    } else {
        s.into()
    }
}

fn grid(c: &Colors) -> Color {
    alpha(c.text, 0.08)
}

fn dim(color: Color, on: bool) -> Color {
    if on { color } else { alpha(color, color.a * 0.45) }
}

fn lit(at: Option<usize>, i: usize) -> bool {
    at.is_none_or(|a| a == i)
}

fn words(s: impl Into<String>, x: f32, y: f32, color: Color) -> Text {
    Text {
        content: s.into(),
        position: Point::new(x, y),
        color,
        size: FS_XS.into(),
        font: theme::TEXT,
        align_y: Vertical::Center,
        ..Text::default()
    }
}

fn right(t: Text) -> Text {
    Text { align_x: Align::Right, ..t }
}

fn centred(t: Text) -> Text {
    Text { align_x: Align::Center, ..t }
}

fn line(f: &mut Frame, a: Point, b: Point, color: Color) {
    f.stroke(&Path::line(a, b), Stroke::default().with_color(color).with_width(1.0));
}

fn dashed(f: &mut Frame, a: Point, b: Point, color: Color) {
    let stroke = Stroke {
        line_dash: LineDash { segments: &[4.0, 3.0], offset: 0 },
        ..Stroke::default().with_color(color).with_width(1.0)
    };
    f.stroke(&Path::line(a, b), stroke);
}

/// A dot with a ring of the page's colour, so it stays clear where lines cross.
fn dot(f: &mut Frame, c: &Colors, at: Point, r: f32, color: Color) {
    f.fill(&Path::circle(at, r + 1.5), c.bg);
    f.fill(&Path::circle(at, r), color);
}

fn polyline(f: &mut Frame, points: impl IntoIterator<Item = Option<Point>>, color: Color) {
    let path = Path::new(|b| {
        let mut pen = false;
        for p in points {
            match p {
                Some(p) if pen => b.line_to(p),
                Some(p) => {
                    b.move_to(p);
                    pen = true;
                }
                None => pen = false,
            }
        }
    });
    let stroke = Stroke {
        line_cap: canvas::LineCap::Round,
        line_join: canvas::LineJoin::Round,
        ..Stroke::default().with_color(color).with_width(2.0)
    };
    f.stroke(&path, stroke);
}

/// A bar from `base` to `end` along y, rounded only at its end.
fn bar_path(x: f32, w: f32, base: f32, end: f32, radius: f32) -> Path {
    let up = end < base;
    let r = radius.min(w / 2.0).min((base - end).abs());
    let e = if up { end + r } else { end - r };
    Path::new(|b| {
        b.move_to(Point::new(x, base));
        b.line_to(Point::new(x, e));
        b.quadratic_curve_to(Point::new(x, end), Point::new(x + r, end));
        b.line_to(Point::new(x + w - r, end));
        b.quadratic_curve_to(Point::new(x + w, end), Point::new(x + w, e));
        b.line_to(Point::new(x + w, base));
        b.close();
    })
}

/// The same along x.
fn hbar_path(y: f32, h: f32, base: f32, end: f32, radius: f32) -> Path {
    let right = end > base;
    let r = radius.min(h / 2.0).min((base - end).abs());
    let e = if right { end - r } else { end + r };
    Path::new(|b| {
        b.move_to(Point::new(base, y));
        b.line_to(Point::new(e, y));
        b.quadratic_curve_to(Point::new(end, y), Point::new(end, y + r));
        b.line_to(Point::new(end, y + h - r));
        b.quadratic_curve_to(Point::new(end, y + h), Point::new(e, y + h));
        b.line_to(Point::new(base, y + h));
        b.close();
    })
}

fn rounded(f: &mut Frame, x: f32, y: f32, w: f32, h: f32, r: f32, color: Color) {
    f.fill(&Path::rounded_rectangle(Point::new(x, y), Size::new(w.max(0.0), h.max(0.0)), r.into()), color);
}

/// A stack's segments in pixels along `at`: a 2px gap from the segment below, and only the stack's outer
/// ends rounded. One too thin to see is left out. (series, base, end, outer)
fn segments(stack: &[Option<(f64, f64)>], at: impl Fn(f64) -> f32) -> Vec<(usize, f32, f32, bool)> {
    let up = (at(1.0) - at(0.0)).signum();
    stack
        .iter()
        .enumerate()
        .filter_map(|(si, sp)| {
            let (from, to) = (*sp)?;
            let base = if from == 0.0 { at(0.0) } else { at(from) + if to > 0.0 { 2.0 } else { -2.0 } * up };
            let outer = !stack[si + 1..].iter().any(|o| o.is_some_and(|o| (o.1 > 0.0) == (to > 0.0)));
            ((base - at(to)).abs() >= 1.0).then_some((si, base, at(to), outer))
        })
        .collect()
}

// The readout

#[derive(Default)]
struct Tip {
    lines: Vec<TipLine>,
}

enum TipLine {
    Muted(String),
    Row {
        key: Option<Color>,
        value: String,
        name: Option<String>,
        /// Lined up past the keys of the rows above.
        indent: bool,
    },
}

impl TipLine {
    fn width(&self) -> f32 {
        match self {
            TipLine::Muted(s) => est(s, FS_XS),
            TipLine::Row { key, value, name, indent } => {
                let key = if key.is_some() || *indent { 18.0 } else { 0.0 };
                key + est(value, FS_XS) * 1.06 + name.as_ref().map_or(0.0, |n| SP_SM + est(n, FS_XS))
            }
        }
    }
}

impl Tip {
    fn muted(mut self, s: impl Into<String>) -> Self {
        self.lines.push(TipLine::Muted(s.into()));
        self
    }

    fn row(mut self, key: Option<Color>, value: impl Into<String>, name: Option<String>) -> Self {
        self.lines.push(TipLine::Row { key, value: value.into(), name, indent: false });
        self
    }

    fn total(mut self, value: impl Into<String>, name: Option<String>) -> Self {
        self.lines.push(TipLine::Row { key: None, value: value.into(), name, indent: true });
        self
    }

    fn size(&self) -> Size {
        let w = self.lines.iter().map(TipLine::width).fold(0.0, f32::max);
        Size::new(w + 2.0 * SP_MD, self.lines.len() as f32 * LINE_H + 2.0 * SP)
    }

    /// Beside `x` on the side with more room, its top at `y`, kept inside the plot.
    fn beside(&self, f: &mut Frame, c: &Colors, x: f32, y: f32) {
        let s = self.size();
        let left = if x < f.width() / 2.0 { x + 12.0 } else { x - 12.0 - s.width };
        self.draw(f, c, Point::new(left, y));
    }

    fn draw(&self, f: &mut Frame, c: &Colors, at: Point) {
        let s = self.size();
        let x = at.x.clamp(0.0, (f.width() - s.width).max(0.0));
        let y = at.y.clamp(0.0, (f.height() - s.height).max(0.0));
        rounded(f, x, y, s.width, s.height, R_MD, c.surface_2);
        let mut cy = y + SP + LINE_H / 2.0;
        for l in &self.lines {
            match l {
                TipLine::Muted(s) => f.fill_text(words(s.clone(), x + SP_MD, cy, c.muted)),
                TipLine::Row { key, value, name, indent } => {
                    let mut cx = x + SP_MD;
                    if let Some(key) = key {
                        rounded(f, cx, cy - 1.0, 12.0, 2.0, 1.0, *key);
                    }
                    if key.is_some() || *indent {
                        cx += 18.0;
                    }
                    f.fill_text(Text { font: theme::SEMIBOLD, ..words(value.clone(), cx, cy, c.text) });
                    if let Some(n) = name {
                        f.fill_text(words(n.clone(), cx + est(value, FS_XS) * 1.06 + SP_SM, cy, c.muted));
                    }
                }
            }
            cy += LINE_H;
        }
    }
}

// Line and bar

#[derive(Clone)]
struct Columns<'a> {
    s: &'a spec::Series,
    bar: bool,
}

struct ColumnsAt {
    left: f32,
    plot_w: f32,
    bottom: f64,
    top: f64,
    ticks: Vec<f64>,
    end: Option<(usize, f64)>,
}

/// What the value axis must cover: the values, and the reference lines.
fn plotted(s: &spec::Series, stacked: bool) -> Vec<f64> {
    let mut vs: Vec<f64> = if stacked {
        s.stack_spans().iter().flatten().flatten().flat_map(|(a, b)| [*a, *b]).collect()
    } else {
        s.series.iter().flat_map(|l| l.data.iter().flatten().copied()).collect()
    };
    vs.extend(s.refs.iter().map(|r| r.value));
    vs
}

fn range_of(vs: &[f64]) -> (f64, f64) {
    vs.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| (lo.min(*v), hi.max(*v)))
}

impl Columns<'_> {
    fn fmt(&self, v: f64, compact: bool) -> String {
        format(v, self.s.unit.as_deref(), compact)
    }

    fn n(&self) -> usize {
        self.s.x.len()
    }

    fn at(&self, w: f32) -> ColumnsAt {
        let (mut lo, mut hi) = range_of(&plotted(self.s, self.s.is_stacked(self.bar)));
        if self.bar {
            lo = lo.min(0.0);
            hi = hi.max(0.0);
        }
        let ticks = nice_ticks(lo, hi, 4);
        let left = ticks.iter().map(|t| est(&self.fmt(*t, true), FS_XS)).fold(0.0, f32::max) + 8.0;
        let end = if !self.bar && self.s.series.len() == 1 {
            self.s.series[0].data.iter().enumerate().rev().find_map(|(i, v)| v.map(|v| (i, v)))
        } else {
            None
        };
        let right = end.map_or(6.0, |(_, v)| est(&self.fmt(v, false), FS_XS) + 12.0);
        ColumnsAt {
            left,
            plot_w: (w - left - right).max(40.0),
            bottom: ticks[0],
            top: *ticks.last().unwrap_or(&1.0),
            ticks,
            end,
        }
    }
}

impl ColumnsAt {
    fn y(&self, v: f64) -> f32 {
        let span = if self.top == self.bottom { 1.0 } else { self.top - self.bottom };
        TOP + PLOT_H - ((v - self.bottom) / span) as f32 * PLOT_H
    }

    fn band(&self, n: usize) -> f32 {
        self.plot_w / n as f32
    }

    fn x(&self, i: usize, n: usize, bar: bool) -> f32 {
        if bar {
            self.left + self.band(n) * (i as f32 + 0.5)
        } else if n == 1 {
            self.left + self.plot_w / 2.0
        } else {
            self.left + i as f32 * self.plot_w / (n - 1) as f32
        }
    }
}

fn series_tip(s: &spec::Series, bar: bool, c: &Colors, i: usize) -> Tip {
    let names = s.names();
    let single = s.series.len() == 1;
    let fmt = |v: f64| format(v, s.unit.as_deref(), false);
    let mut tip = Tip::default().muted(s.x[i].clone());
    for (si, l) in s.series.iter().enumerate() {
        let value = l.data[i].map_or("–".into(), fmt);
        tip = tip.row(Some(c.series[si]), value, (!single).then(|| names[si].clone()));
    }
    if s.is_stacked(bar)
        && let Some(total) = s.stack_totals()[i]
    {
        tip = tip.total(fmt(total), Some("total".into()));
    }
    tip
}

impl Plot for Columns<'_> {
    fn height(&self, _: f32) -> f32 {
        HEIGHT
    }

    fn pick(&self, w: f32, p: Point) -> Option<usize> {
        let a = self.at(w);
        let n = self.n();
        if n == 1 {
            return Some(0);
        }
        let i = if self.bar {
            ((p.x - a.left) / a.band(n)).floor()
        } else {
            ((p.x - a.left) / a.plot_w * (n - 1) as f32).round()
        };
        Some(i.clamp(0.0, (n - 1) as f32) as usize)
    }

    fn draw(&self, f: &mut Frame, c: &Colors, at: Option<usize>) {
        let (s, bar, n) = (self.s, self.bar, self.n());
        let a = self.at(f.width());
        let stacked = s.is_stacked(bar);
        let x = |i: usize| a.x(i, n, bar);
        for t in &a.ticks {
            let y = a.y(*t);
            line(
                f,
                Point::new(a.left, y),
                Point::new(a.left + a.plot_w, y),
                if bar && *t == 0.0 { c.line } else { grid(c) },
            );
            f.fill_text(right(words(self.fmt(*t, true), a.left - 8.0, y, c.muted)));
        }
        for r in &s.refs {
            let y = a.y(r.value);
            dashed(f, Point::new(a.left, y), Point::new(a.left + a.plot_w, y), c.text_2);
            f.fill_text(right(words(r.label.clone(), a.left + a.plot_w, y - 7.0, c.text_2)));
        }

        // Bars label every category, cut to fit its band, while that leaves a word; otherwise every
        // step-th x, as many as fit.
        let band = a.band(n);
        let room = ((band - 8.0) / (0.55 * FS_XS)).floor().max(0.0) as usize;
        let every = bar && room >= 4;
        let cut = if every { room.min(12) } else { 12 };
        let longest = s.x.iter().map(|l| l.chars().count()).max().unwrap_or(1).min(cut);
        let label_w = longest as f32 * 0.55 * FS_XS + 10.0;
        let step = if every { 1 } else { n.div_ceil(((a.plot_w / label_w).floor() as usize).max(1)) };
        for i in (0..n).step_by(step.max(1)) {
            let t = words(cut_to(&s.x[i], cut), x(i), HEIGHT - 9.0, c.muted);
            f.fill_text(if bar || n == 1 {
                centred(t)
            } else if i == 0 {
                t
            } else if i == n - 1 {
                right(t)
            } else {
                centred(t)
            });
        }

        let k = if stacked { 1 } else { s.series.len() };
        let kf = k as f32;
        let group_w = (band * 0.72).min(24.0 * kf + 2.0 * (kf - 1.0));
        let bar_w = ((group_w - 2.0 * (kf - 1.0)) / kf).clamp(1.0, 24.0);
        if stacked {
            for (i, stack) in s.stack_spans().iter().enumerate() {
                for (si, base, end, outer) in segments(stack, |v| a.y(v)) {
                    let p = bar_path(x(i) - bar_w / 2.0, bar_w, base, end, if outer { 4.0 } else { 0.0 });
                    f.fill(&p, dim(c.series[si], lit(at, i)));
                }
            }
        } else if bar {
            for (si, l) in s.series.iter().enumerate() {
                for (i, v) in l.data.iter().enumerate() {
                    let Some(v) = v.filter(|v| *v != 0.0) else { continue };
                    let bx = x(i) - group_w / 2.0
                        + si as f32 * (bar_w + 2.0)
                        + (group_w - kf * bar_w - 2.0 * (kf - 1.0)) / 2.0;
                    f.fill(&bar_path(bx, bar_w, a.y(0.0), a.y(v), 4.0), dim(c.series[si], lit(at, i)));
                }
            }
        } else {
            for (si, l) in s.series.iter().enumerate() {
                polyline(f, l.data.iter().enumerate().map(|(i, v)| v.map(|v| Point::new(x(i), a.y(v)))), c.series[si]);
                for (i, v) in l.data.iter().enumerate() {
                    // A point with gaps both sides has no line to show it.
                    let alone = i.checked_sub(1).is_none_or(|p| l.data[p].is_none())
                        && l.data.get(i + 1).is_none_or(Option::is_none);
                    if let Some(v) = v.filter(|_| alone) {
                        f.fill(&Path::circle(Point::new(x(i), a.y(v)), 2.5), c.series[si]);
                    }
                }
            }
            if let Some(i) = at {
                line(f, Point::new(x(i), TOP), Point::new(x(i), TOP + PLOT_H), c.line);
            }
            for (si, l) in s.series.iter().enumerate() {
                let i = at.or_else(|| l.data.iter().rposition(Option::is_some));
                if let Some((i, Some(v))) = i.map(|i| (i, l.data[i])) {
                    dot(f, c, Point::new(x(i), a.y(v)), 4.0, c.series[si]);
                }
            }
            if let Some((i, v)) = a.end {
                f.fill_text(words(self.fmt(v, false), x(i) + 9.0, a.y(v), c.muted));
            }
        }
        if let Some(i) = at {
            series_tip(s, bar, c, i).beside(f, c, x(i), 0.0);
        }
    }
}

const ROW_GAP: f32 = 10.0;
const REF_H: f32 = 16.0;

#[derive(Clone)]
struct Rows<'a> {
    s: &'a spec::Series,
}

impl Rows<'_> {
    fn k(&self) -> usize {
        if self.s.is_stacked(true) { 1 } else { self.s.series.len() }
    }

    fn thick(&self) -> f32 {
        if self.k() == 1 { 14.0 } else { 10.0 }
    }

    fn row_h(&self) -> f32 {
        let k = self.k() as f32;
        k * self.thick() + 2.0 * (k - 1.0) + ROW_GAP
    }

    /// The reference lines' labels go above the rows.
    fn ref_top(&self) -> f32 {
        if self.s.refs.is_empty() { 0.0 } else { REF_H }
    }

    fn row_top(&self, i: usize) -> f32 {
        self.ref_top() + i as f32 * self.row_h() + ROW_GAP / 2.0
    }
}

impl Plot for Rows<'_> {
    fn height(&self, _: f32) -> f32 {
        self.ref_top() + self.s.x.len() as f32 * self.row_h()
    }

    fn pick(&self, _: f32, p: Point) -> Option<usize> {
        let i = ((p.y - self.ref_top()) / self.row_h()).floor();
        Some(i.clamp(0.0, (self.s.x.len() - 1) as f32) as usize)
    }

    fn draw(&self, f: &mut Frame, c: &Colors, at: Option<usize>) {
        let s = self.s;
        let w = f.width();
        let stacked = s.is_stacked(true);
        let spans = if stacked { s.stack_spans() } else { vec![] };
        let totals = if stacked { s.stack_totals() } else { vec![] };
        let fmt = |v: f64| format(v, s.unit.as_deref(), false);
        let thick = self.thick();
        let (lo, hi) = range_of(&plotted(s, stacked));
        let (lo, hi) = (lo.min(0.0), hi.max(0.0));
        let tips: Vec<f64> = if stacked {
            totals.iter().flatten().copied().collect()
        } else {
            s.series.iter().flat_map(|l| l.data.iter().flatten().copied()).collect()
        };
        let tip_w = |neg: bool| {
            tips.iter().filter(|v| (**v < 0.0) == neg).map(|v| est(&fmt(*v), FS_XS) + 8.0).fold(0.0, f32::max)
        };
        let cut = (((w * 0.4 - 10.0) / (0.55 * FS_XS)).floor() as usize).clamp(4, 18);
        let left = s.x.iter().map(|l| l.chars().count()).max().unwrap_or(1).min(cut) as f32 * 0.55 * FS_XS + 10.0;
        let neg_room = if lo < 0.0 { tip_w(true) } else { 0.0 };
        let plot_w = (w - left - neg_room - tip_w(false)).max(40.0);
        let span = if hi > lo { hi - lo } else { 1.0 };
        let v = |val: f64| left + neg_room + ((val - lo) / span) as f32 * plot_w;
        let height = self.height(w);
        let ref_top = self.ref_top();
        let tip = |f: &mut Frame, val: f64, cy: f32, end: f32, on: bool| {
            let t = words(fmt(val), if val < 0.0 { end - 6.0 } else { end + 6.0 }, cy, dim(c.muted, on));
            f.fill_text(if val < 0.0 { right(t) } else { t });
        };

        for (i, l) in s.x.iter().enumerate() {
            f.fill_text(words(cut_to(l, cut), 0.0, self.row_top(i) + (self.row_h() - ROW_GAP) / 2.0, c.text_2));
        }
        line(f, Point::new(v(0.0), ref_top), Point::new(v(0.0), height), c.line);
        for r in &s.refs {
            dashed(f, Point::new(v(r.value), ref_top - 2.0), Point::new(v(r.value), height), c.text_2);
            f.fill_text(centred(words(r.label.clone(), v(r.value), REF_H / 2.0 - 2.0, c.text_2)));
        }
        if stacked {
            for (i, stack) in spans.iter().enumerate() {
                let on = lit(at, i);
                for (si, base, end, outer) in segments(stack, v) {
                    let p = hbar_path(self.row_top(i), thick, base, end, if outer { 4.0 } else { 0.0 });
                    f.fill(&p, dim(c.series[si], on));
                }
                if let Some(total) = totals[i] {
                    let ends = stack.iter().flatten().map(|sp| sp.1);
                    let end = if total < 0.0 {
                        ends.fold(f64::INFINITY, f64::min)
                    } else {
                        ends.fold(f64::NEG_INFINITY, f64::max)
                    };
                    if end.is_finite() {
                        tip(f, total, self.row_top(i) + thick / 2.0, v(end), on);
                    }
                }
            }
        } else {
            for i in 0..s.x.len() {
                let on = lit(at, i);
                for (si, l) in s.series.iter().enumerate() {
                    let Some(val) = l.data[i] else { continue };
                    let top = self.row_top(i) + si as f32 * (thick + 2.0);
                    if val != 0.0 {
                        f.fill(&hbar_path(top, thick, v(0.0), v(val), 4.0), dim(c.series[si], on));
                    }
                    tip(f, val, top + thick / 2.0, v(val), on);
                }
            }
        }
        // The values are written at the bars' ends already; the readout adds names where it fits.
        if let Some(i) = at {
            let t = series_tip(s, true, c, i);
            let th = t.size().height;
            if th <= height {
                let below = self.row_top(i) + self.row_h();
                let y = if below + th <= height {
                    below - ROW_GAP / 2.0
                } else {
                    self.row_top(i) - ROW_GAP / 2.0 - th - 4.0
                };
                t.draw(f, c, Point::new(left, y));
            }
        }
    }
}

// Scatter

const SCATTER_H: f32 = 190.0;
const NAME_H: f32 = 16.0;

#[derive(Clone)]
struct Scatter<'a> {
    s: &'a spec::Scatter,
}

struct ScatterAt<'a> {
    pts: Vec<(&'a spec::Point, usize)>,
    top: f32,
    left: f32,
    plot_w: f32,
    x_ticks: Vec<f64>,
    y_ticks: Vec<f64>,
}

impl ScatterAt<'_> {
    fn x(&self, v: f64) -> f32 {
        let (lo, hi) = (self.x_ticks[0], *self.x_ticks.last().unwrap_or(&1.0));
        self.left + ((v - lo) / if hi > lo { hi - lo } else { 1.0 }) as f32 * self.plot_w
    }

    fn y(&self, v: f64) -> f32 {
        let (lo, hi) = (self.y_ticks[0], *self.y_ticks.last().unwrap_or(&1.0));
        self.top + SCATTER_H - ((v - lo) / if hi > lo { hi - lo } else { 1.0 }) as f32 * SCATTER_H
    }
}

impl<'a> Scatter<'a> {
    fn at(&self, w: f32) -> ScatterAt<'a> {
        let s = self.s;
        let mut pts: Vec<(&spec::Point, usize)> =
            s.series.iter().enumerate().flat_map(|(si, se)| se.points.iter().map(move |p| (p, si))).collect();
        pts.sort_by(|a, b| a.0.x.total_cmp(&b.0.x).then(a.0.y.total_cmp(&b.0.y)));
        let top = if s.y_name.is_some() { NAME_H + 6.0 } else { 8.0 };
        let (ylo, yhi) = range_of(&pts.iter().map(|p| p.0.y).collect::<Vec<_>>());
        let y_ticks = nice_ticks(ylo, yhi, 4);
        let left = y_ticks.iter().map(|t| est(&format(*t, s.y_unit.as_deref(), true), FS_XS)).fold(0.0, f32::max) + 8.0;
        let (xlo, xhi) = range_of(&pts.iter().map(|p| p.0.x).collect::<Vec<_>>());
        // Fewer x ticks on a narrow plot; the last one's label is centred on the plot's right edge.
        let guess = (((w - left) / 80.0).floor() as usize).max(2);
        let x_ticks = nice_ticks(xlo, xhi, guess);
        let last = x_ticks.last().map_or(0.0, |t| est(&format(*t, s.x_unit.as_deref(), true), FS_XS));
        let plot_w = (w - left - last / 2.0 - 2.0).max(40.0);
        ScatterAt { pts, top, left, plot_w, x_ticks, y_ticks }
    }
}

impl Plot for Scatter<'_> {
    fn height(&self, _: f32) -> f32 {
        let top = if self.s.y_name.is_some() { NAME_H + 6.0 } else { 8.0 };
        top + SCATTER_H + AXIS_H + if self.s.x_name.is_some() { NAME_H } else { 0.0 }
    }

    fn pick(&self, w: f32, p: Point) -> Option<usize> {
        let a = self.at(w);
        let mut best = None;
        let mut best_d = 24.0;
        for (i, (pt, _)) in a.pts.iter().enumerate() {
            let d = (a.x(pt.x) - p.x).hypot(a.y(pt.y) - p.y);
            if d < best_d {
                (best, best_d) = (Some(i), d);
            }
        }
        best
    }

    fn draw(&self, f: &mut Frame, c: &Colors, at: Option<usize>) {
        let s = self.s;
        let w = f.width();
        let a = self.at(w);
        let multi = s.series.len() > 1;
        let names = s.names();
        if let Some(name) = &s.y_name {
            f.fill_text(words(name.clone(), 0.0, NAME_H / 2.0, c.text_2));
        }
        let bottom = a.top + SCATTER_H;
        for t in &a.y_ticks {
            line(f, Point::new(a.left, a.y(*t)), Point::new(a.left + a.plot_w, a.y(*t)), grid(c));
            f.fill_text(right(words(format(*t, s.y_unit.as_deref(), true), a.left - 8.0, a.y(*t), c.muted)));
        }
        let ticks_y = bottom + 14.0;
        for t in &a.x_ticks {
            line(f, Point::new(a.x(*t), a.top), Point::new(a.x(*t), bottom), grid(c));
            f.fill_text(centred(words(format(*t, s.x_unit.as_deref(), true), a.x(*t), ticks_y, c.muted)));
        }
        if let Some(name) = &s.x_name {
            f.fill_text(right(words(name.clone(), a.left + a.plot_w, ticks_y + NAME_H, c.text_2)));
        }
        for (i, (pt, si)) in a.pts.iter().enumerate() {
            dot(f, c, Point::new(a.x(pt.x), a.y(pt.y)), 4.0, dim(c.series[*si], lit(at, i)));
        }

        // Names beside their points, each on the first side where it hits nothing drawn so far.
        if a.pts.len() <= 12 {
            let mut taken: Vec<[f32; 4]> =
                a.pts.iter().map(|(p, _)| [a.x(p.x) - 5.0, a.y(p.y) - 5.0, a.x(p.x) + 5.0, a.y(p.y) + 5.0]).collect();
            for (i, (pt, _)) in a.pts.iter().enumerate() {
                let Some(label) = &pt.label else { continue };
                let (cx, cy) = (a.x(pt.x), a.y(pt.y));
                let label = cut_to(label, 18);
                let lw = est(&label, FS_XS);
                let sides = [
                    (cx + 8.0, cy, Align::Left, cx + 7.0, cx + 9.0 + lw),
                    (cx - 8.0, cy, Align::Right, cx - 9.0 - lw, cx - 7.0),
                    (cx, cy - 12.0, Align::Center, cx - lw / 2.0, cx + lw / 2.0),
                    (cx, cy + 12.0, Align::Center, cx - lw / 2.0, cx + lw / 2.0),
                ];
                for (x, y, align, x0, x1) in sides {
                    let b = [x0, y - 7.0, x1, y + 7.0];
                    let inside = b[0] >= 0.0 && b[2] <= w && b[1] >= 0.0 && b[3] <= bottom + 4.0;
                    let hits = taken.iter().any(|t| t[0] < b[2] && b[0] < t[2] && t[1] < b[3] && b[1] < t[3]);
                    if inside && !hits {
                        taken.push(b);
                        f.fill_text(Text { align_x: align, ..words(label, x, y, dim(c.muted, lit(at, i))) });
                        break;
                    }
                }
            }
        }

        if let Some((pt, si)) = at.and_then(|i| a.pts.get(i)) {
            let (cx, cy) = (a.x(pt.x), a.y(pt.y));
            dot(f, c, Point::new(cx, cy), 5.5, c.series[*si]);
            let head: Vec<String> =
                [pt.label.clone(), multi.then(|| names[*si].clone())].into_iter().flatten().collect();
            let mut tip = Tip::default();
            if !head.is_empty() {
                tip = tip.muted(head.join(" · "));
            }
            tip = tip.row(
                multi.then_some(c.series[*si]),
                format(pt.x, s.x_unit.as_deref(), false),
                Some(s.x_name.clone().unwrap_or_else(|| "x".into())),
            );
            let y_value = format(pt.y, s.y_unit.as_deref(), false);
            let y_name = Some(s.y_name.clone().unwrap_or_else(|| "y".into()));
            tip = if multi { tip.total(y_value, y_name) } else { tip.row(None, y_value, y_name) };
            let th = tip.size().height;
            let y = if cy < a.top + SCATTER_H / 2.0 { cy + 8.0 } else { cy - 8.0 - th };
            tip.beside(f, c, cx, y);
        }
    }
}

// Range

const RANGE_THICK: f32 = 14.0;

#[derive(Clone)]
struct Range<'a> {
    r: &'a spec::Ranges,
}

impl Range<'_> {
    fn narrow(w: f32) -> bool {
        w < 440.0
    }

    fn row_h(w: f32) -> f32 {
        if Self::narrow(w) { 40.0 } else { 24.0 }
    }
}

impl Plot for Range<'_> {
    fn height(&self, w: f32) -> f32 {
        self.r.rows.len() as f32 * Self::row_h(w) + AXIS_H
    }

    fn pick(&self, w: f32, p: Point) -> Option<usize> {
        Some(((p.y / Self::row_h(w)).floor().max(0.0) as usize).min(self.r.rows.len() - 1))
    }

    fn draw(&self, f: &mut Frame, c: &Colors, at: Option<usize>) {
        let r = self.r;
        let w = f.width();
        let fmt = |v: f64, compact: bool| format(v, r.unit.as_deref(), compact);
        let narrow = Self::narrow(w);
        let row_h = Self::row_h(w);
        let char_w = 0.55 * FS_XS;
        let cut = if narrow {
            (w / char_w).floor() as usize
        } else {
            (((w * 0.35 - 10.0) / char_w).floor() as usize).clamp(4, 18)
        };
        let left = if narrow {
            0.0
        } else {
            r.rows.iter().map(|row| row.label.chars().count()).max().unwrap_or(1).min(cut) as f32 * char_w + 10.0
        };
        let low_w = r.rows.iter().map(|row| est(&fmt(row.low, false), FS_XS)).fold(0.0, f32::max) + 8.0;
        let high_w = r.rows.iter().map(|row| est(&fmt(row.high, false), FS_XS)).fold(0.0, f32::max) + 8.0;
        let plot_x = left + low_w;
        let plot_w = (w - plot_x - high_w).max(40.0);
        // The axis spans the values, not zero: ranges float. Ticks are the round values inside it.
        let lo = r.rows.iter().map(|row| row.low).fold(f64::INFINITY, f64::min);
        let hi = r.rows.iter().map(|row| row.high).fold(f64::NEG_INFINITY, f64::max);
        let count = ((plot_w / 50.0).floor() as usize).max(2);
        let ticks: Vec<f64> = nice_ticks(lo, hi, count).into_iter().filter(|t| *t >= lo && *t <= hi).collect();
        let v = |val: f64| plot_x + if hi > lo { ((val - lo) / (hi - lo)) as f32 * plot_w } else { plot_w / 2.0 };
        let plot_h = r.rows.len() as f32 * row_h;
        let height = plot_h + AXIS_H;
        let mid = |i: usize| i as f32 * row_h + if narrow { 27.0 } else { row_h / 2.0 };

        for t in &ticks {
            line(f, Point::new(v(*t), 0.0), Point::new(v(*t), plot_h), grid(c));
            f.fill_text(centred(words(fmt(*t, true), v(*t), height - 9.0, c.muted)));
        }
        for (i, row) in r.rows.iter().enumerate() {
            let on = lit(at, i);
            let cy = mid(i);
            // A range with no width still shows, as a short pill.
            let (x0, x1) = if v(row.high) - v(row.low) < 4.0 {
                (v(row.low) - 2.0, v(row.low) + 2.0)
            } else {
                (v(row.low), v(row.high))
            };
            f.fill_text(words(cut_to(&row.label, cut), 0.0, if narrow { cy - 18.0 } else { cy }, dim(c.text_2, on)));
            rounded(
                f,
                x0,
                cy - RANGE_THICK / 2.0,
                x1 - x0,
                RANGE_THICK,
                4.0f32.min((x1 - x0) / 2.0),
                dim(c.series[0], on),
            );
            f.fill_text(right(words(fmt(row.low, false), x0 - 6.0, cy, dim(c.muted, on))));
            if row.high != row.low {
                f.fill_text(words(fmt(row.high, false), x1 + 6.0, cy, dim(c.muted, on)));
            }
            if let Some(m) = row.mark {
                dot(f, c, Point::new(v(m), cy), 4.0, dim(c.text, on));
            }
        }
        if let Some(i) = at {
            let row = &r.rows[i];
            let mut tip = Tip::default().muted(row.label.clone());
            tip = tip.row(None, format!("{} – {}", fmt(row.low, false), fmt(row.high, false)), None);
            if let Some(m) = row.mark {
                tip = tip.row(None, fmt(m, false), Some(r.mark_name.clone().unwrap_or_else(|| "mark".into())));
            }
            let th = tip.size().height;
            let y = if mid(i) < plot_h / 2.0 || r.rows.len() < 4 {
                (i + 1) as f32 * row_h
            } else {
                i as f32 * row_h - 4.0 - th
            };
            tip.draw(f, c, Point::new(left, y));
        }
    }
}

// Timeline

const TRACK: f32 = 22.0;
const LANE_H: f32 = 20.0;
const EVENT_THICK: f32 = 8.0;

#[derive(Clone)]
struct Timeline<'a> {
    t: &'a spec::Timeline,
}

#[derive(Clone, Copy, PartialEq)]
enum Beside {
    Right,
    Left,
    Under,
}

struct Placed<'a> {
    e: &'a spec::Event,
    span: bool,
    x0: f32,
    x1: f32,
    text: String,
    side: Beside,
    lx: f32,
    reach: (f32, f32),
    lane: usize,
    track: usize,
}

struct TimelineAt<'a> {
    placed: Vec<Placed<'a>>,
    lanes: Vec<(String, usize)>,
    lane_top: Vec<f32>,
    named: bool,
    ticks: Vec<(f32, String)>,
    plot_h: f32,
}

impl TimelineAt<'_> {
    fn row_y(&self, e: &Placed) -> f32 {
        self.lane_top[e.lane] + if self.named { LANE_H } else { 0.0 } + e.track as f32 * TRACK + TRACK / 2.0
    }

    fn height(&self) -> f32 {
        self.plot_h + AXIS_H
    }
}

/// Ticks inside [lo, hi] (days since 1970), no closer than `gap` px on a `width` px axis: years, months or
/// days, whichever the span needs.
fn time_ticks(lo: i64, hi: i64, width: f32, gap: f32) -> Vec<(i64, String)> {
    let fit = ((width / gap).floor() as i64).max(2) as f64;
    let days = (hi - lo) as f64;
    let (y0, m0, _) = spec::civil(lo);
    let mut ticks: Vec<(i64, String)> = vec![];
    if days > 3.0 * 366.0 {
        let years = days / 365.25;
        let step = [1, 2, 5, 10, 20, 50, 100, 200, 500].into_iter().find(|s| years / *s as f64 <= fit).unwrap_or(1000);
        let mut y = y0.div_euclid(step) * step;
        loop {
            let t = spec::day_number(y, 1, 1);
            ticks.push((t, y.to_string()));
            if t >= hi {
                break;
            }
            y += step;
        }
    } else if days > 62.0 {
        let months = days / 30.4;
        let step = [1, 2, 3, 6, 12].into_iter().find(|s| months / *s as f64 <= fit).unwrap_or(12);
        let mut k = (y0 * 12 + m0 - 1).div_euclid(step) * step;
        loop {
            let (y, m) = (k.div_euclid(12), k.rem_euclid(12) + 1);
            let t = spec::day_number(y, m, 1);
            ticks.push((t, if m == 1 { y.to_string() } else { spec::month_name(m).to_string() }));
            if t >= hi {
                break;
            }
            k += step;
        }
    } else {
        let step = [1, 2, 7, 14].into_iter().find(|s| days / *s as f64 <= fit).unwrap_or(28);
        let mut t = lo;
        loop {
            let (_, m, d) = spec::civil(t);
            ticks.push((t, format!("{} {d}", spec::month_name(m))));
            if t >= hi {
                break;
            }
            t += step;
        }
    }
    let mut inside: Vec<(i64, String)> = ticks.into_iter().filter(|(t, _)| *t >= lo && *t <= hi).collect();
    // Without a January on a month axis, the first tick says the year.
    if days > 62.0
        && !inside.iter().any(|(_, s)| s.starts_with(|c: char| c.is_ascii_digit()))
        && let Some((t, s)) = inside.first_mut()
    {
        *s = format!("{s} {}", spec::civil(*t).0);
    }
    inside
}

impl<'a> Timeline<'a> {
    fn at(&self, width: f32) -> TimelineAt<'a> {
        let char_w = 0.55 * FS_XS;
        let lane_names = self.t.lanes();
        let named = lane_names.len() > 1 || !lane_names[0].is_empty();
        let mut events: Vec<(&spec::Event, i64, i64)> = self
            .t
            .events
            .iter()
            .filter_map(|e| {
                let t0 = spec::date_range(&e.date)?.0;
                let t1 = spec::date_range(e.end.as_deref().unwrap_or(&e.date))?.1 + 1;
                Some((e, t0, t1))
            })
            .collect();
        events.sort_by_key(|e| (e.1, e.2));
        let pad = 5.0;
        let plot_w = (width - 2.0 * pad).max(40.0);
        let lo = events.iter().map(|e| e.1).min().unwrap_or(0);
        let hi = events.iter().map(|e| e.2).max().unwrap_or(1).max(lo + 1);
        let x = |t: f64| pad + ((t - lo as f64) / (hi - lo) as f64) as f32 * plot_w;
        let mut placed: Vec<Placed> = events
            .iter()
            .map(|&(e, t0, t1)| {
                let span = e.end.is_some();
                let (x0, x1) = if span {
                    (x(t0 as f64), x(t1 as f64).max(x(t0 as f64) + EVENT_THICK))
                } else {
                    let mid = x((t0 + t1) as f64 / 2.0);
                    (mid - 4.0, mid + 4.0)
                };
                let full = est(&e.label, FS_XS);
                // Beside the mark, right first; where neither side has room, on the track below it.
                let side = if width - x1 - 6.0 >= full {
                    Beside::Right
                } else if x0 - 6.0 >= full {
                    Beside::Left
                } else {
                    Beside::Under
                };
                let text = cut_to(&e.label, (width / char_w).floor() as usize);
                let tw = est(&text, FS_XS);
                let lx = match side {
                    Beside::Right => x1 + 6.0,
                    Beside::Left => x0 - 6.0,
                    Beside::Under => x0.clamp(0.0, (width - tw).max(0.0)),
                };
                let reach = match side {
                    Beside::Right => (x0, lx + tw),
                    Beside::Left => (lx - tw, x1),
                    Beside::Under => (x0.min(lx), x1.max(lx + tw)),
                };
                let lane = lane_names.iter().position(|l| l == e.lane.as_deref().unwrap_or_default()).unwrap_or(0);
                Placed { e, span, x0, x1, text, side, lx, reach, lane, track: 0 }
            })
            .collect();
        let mut lanes = vec![];
        for (li, name) in lane_names.iter().enumerate() {
            let mut ends: Vec<f32> = vec![];
            let free = |ends: &Vec<f32>, k: usize, from: f32| ends.get(k).is_none_or(|e| e + 8.0 <= from);
            for p in placed.iter_mut().filter(|p| p.lane == li) {
                let under = p.side == Beside::Under;
                let mut k = 0;
                while !free(&ends, k, p.reach.0) || (under && !free(&ends, k + 1, p.reach.0)) {
                    k += 1;
                }
                let need = if under { k + 2 } else { k + 1 };
                if ends.len() < need {
                    ends.resize(need, f32::NEG_INFINITY);
                }
                ends[k] = p.reach.1;
                if under {
                    ends[k + 1] = p.reach.1;
                }
                p.track = k;
            }
            lanes.push((name.clone(), ends.len()));
        }
        let mut y = 4.0;
        let lane_top = lanes
            .iter()
            .map(|(_, tracks)| {
                let top = y;
                y += if named { LANE_H } else { 0.0 } + *tracks as f32 * TRACK;
                top
            })
            .collect();
        let ticks = time_ticks(lo, hi, plot_w, 64.0).into_iter().map(|(t, s)| (x(t as f64), s)).collect();
        TimelineAt { placed, lanes, lane_top, named, ticks, plot_h: y + 4.0 }
    }
}

impl Plot for Timeline<'_> {
    fn height(&self, w: f32) -> f32 {
        self.at(w).height()
    }

    fn pick(&self, w: f32, p: Point) -> Option<usize> {
        let a = self.at(w);
        let mut best = None;
        let mut best_d = 24.0;
        for (i, e) in a.placed.iter().enumerate() {
            let dy = p.y - a.row_y(e);
            if dy < -TRACK / 2.0 || dy > if e.side == Beside::Under { 1.5 } else { 0.5 } * TRACK {
                continue;
            }
            let d = if p.x < e.reach.0 {
                e.reach.0 - p.x
            } else if p.x > e.reach.1 {
                p.x - e.reach.1
            } else {
                0.0
            };
            if d < best_d {
                (best, best_d) = (Some(i), d);
            }
        }
        best
    }

    fn draw(&self, f: &mut Frame, c: &Colors, at: Option<usize>) {
        let w = f.width();
        let a = self.at(w);
        let height = a.height();
        for (tx, s) in &a.ticks {
            line(f, Point::new(*tx, 0.0), Point::new(*tx, a.plot_h), grid(c));
            let tw = est(s, FS_XS);
            let t = words(s.clone(), *tx, height - 9.0, c.muted);
            f.fill_text(if tx - tw / 2.0 < 0.0 {
                t
            } else if tx + tw / 2.0 > w {
                right(t)
            } else {
                centred(t)
            });
        }
        if a.named {
            for (li, (name, _)) in a.lanes.iter().enumerate() {
                let top = a.lane_top[li];
                if li > 0 {
                    line(f, Point::new(0.0, top - 2.0), Point::new(w, top - 2.0), c.line);
                }
                let name = if name.is_empty() { "Other".to_string() } else { name.clone() };
                f.fill_text(Text { font: theme::SEMIBOLD, ..words(name, 0.0, top + LANE_H / 2.0, c.text_2) });
            }
        }
        for (i, e) in a.placed.iter().enumerate() {
            let on = lit(at, i);
            let cy = a.row_y(e);
            if e.span {
                rounded(
                    f,
                    e.x0,
                    cy - EVENT_THICK / 2.0,
                    e.x1 - e.x0,
                    EVENT_THICK,
                    EVENT_THICK / 2.0,
                    dim(c.series[0], on),
                );
            } else {
                dot(f, c, Point::new((e.x0 + e.x1) / 2.0, cy), 4.0, dim(c.series[0], on));
            }
            let t =
                words(e.text.clone(), e.lx, if e.side == Beside::Under { cy + TRACK } else { cy }, dim(c.muted, on));
            f.fill_text(if e.side == Beside::Left { right(t) } else { t });
        }
        if let Some(e) = at.and_then(|i| a.placed.get(i)) {
            let cy = a.row_y(e);
            let lane = e.e.lane.clone().filter(|l| a.named && !l.is_empty());
            let tip = Tip::default().muted(spec::when(e.e)).row(None, e.e.label.clone(), lane);
            let th = tip.size().height;
            let x = if e.span { e.x0 } else { (e.x0 + e.x1) / 2.0 };
            let y = if cy < a.plot_h / 2.0 { cy + TRACK / 2.0 } else { cy - TRACK / 2.0 - th };
            tip.beside(f, c, x, y);
        }
    }
}

// Calendar

const CAL_TOP: f32 = 16.0;
const CAL_LEFT: f32 = 30.0;
const CAL_GAP: f32 = 2.0;

#[derive(Clone)]
struct Calendar<'a> {
    unit: Option<&'a str>,
    days: Vec<&'a spec::Day>,
    weeks: Vec<[i64; 7]>,
    /// Each day's index in `days`, by its number.
    index: HashMap<i64, usize>,
}

impl<'a> Calendar<'a> {
    fn new(c: &'a spec::Calendar) -> Self {
        let mut days: Vec<&spec::Day> = c.days.iter().collect();
        days.sort_by(|a, b| a.date.cmp(&b.date));
        let weeks = spec::calendar_weeks(&days.iter().map(|d| d.date.as_str()).collect::<Vec<_>>());
        let index = days.iter().enumerate().filter_map(|(i, d)| spec::date_range(&d.date).map(|r| (r.0, i))).collect();
        Calendar { unit: c.unit.as_deref(), days, weeks, index }
    }

    fn cell(&self, w: f32) -> f32 {
        (((w - CAL_LEFT) / self.weeks.len().max(1) as f32).floor() - CAL_GAP).clamp(6.0, 14.0)
    }
}

impl Plot for Calendar<'_> {
    fn height(&self, w: f32) -> f32 {
        CAL_TOP + 7.0 * (self.cell(w) + CAL_GAP)
    }

    fn pick(&self, w: f32, p: Point) -> Option<usize> {
        let pitch = self.cell(w) + CAL_GAP;
        if p.x < CAL_LEFT || p.y < CAL_TOP {
            return None;
        }
        let week = self.weeks.get(((p.x - CAL_LEFT) / pitch) as usize)?;
        let day = week.get(((p.y - CAL_TOP) / pitch) as usize)?;
        self.index.get(day).copied()
    }

    fn draw(&self, f: &mut Frame, c: &Colors, at: Option<usize>) {
        let cell = self.cell(f.width());
        let pitch = cell + CAL_GAP;
        // From zero, so a day with nothing (no failed backups) reads as empty.
        let lo = self.days.iter().map(|d| d.value).fold(0.0, f64::min);
        let hi = self.days.iter().map(|d| d.value).fold(f64::NEG_INFINITY, f64::max);
        let strength = |v: f64| if hi > lo { (v - lo) / (hi - lo) } else { 1.0 };
        for (d, name) in ["Mon", "", "Wed", "", "Fri", "", ""].iter().enumerate() {
            if !name.is_empty() {
                f.fill_text(words(*name, 0.0, CAL_TOP + d as f32 * pitch + cell / 2.0, c.text_2));
            }
        }
        for (w, week) in self.weeks.iter().enumerate() {
            // A month's name over the week it starts in, if the last one's name has room.
            let first = week.iter().find(|t| spec::civil(**t).2 == 1).copied();
            let label = match w {
                0 => Some(first.unwrap_or(week[6])),
                1 => None,
                _ => first,
            };
            let x = CAL_LEFT + w as f32 * pitch;
            if let Some(t) = label {
                f.fill_text(Text {
                    align_y: Vertical::Bottom,
                    ..words(spec::month_name(spec::civil(t).1), x, CAL_TOP - 3.0, c.muted)
                });
            }
            for (d, t) in week.iter().enumerate() {
                let i = self.index.get(t).copied();
                let v = i.map(|i| self.days[i].value);
                let y = CAL_TOP + d as f32 * pitch;
                let fill = match v.map(strength) {
                    Some(s) if s > 0.0 => alpha(c.series[0], 0.2 + 0.8 * s as f32),
                    _ => grid(c),
                };
                rounded(f, x, y, cell, cell, 2.0, fill);
                if i.is_some() && i == at {
                    f.stroke(
                        &Path::rounded_rectangle(Point::new(x, y), Size::new(cell, cell), 2.0.into()),
                        Stroke::default().with_color(c.text).with_width(1.5),
                    );
                }
            }
        }
        if let Some(i) = at {
            let day = self.days[i];
            let Some((n, _)) = spec::date_range(&day.date) else { return };
            let w = self.weeks.iter().position(|wk| wk.contains(&n)).unwrap_or(0);
            let (x, y) = (CAL_LEFT + w as f32 * pitch, CAL_TOP + spec::weekday(n) as f32 * pitch);
            let tip =
                Tip::default().muted(spec::date_text(&day.date)).row(None, format(day.value, self.unit, false), None);
            let th = tip.size().height;
            let ty = if y < f.height() / 2.0 { y + pitch } else { y - th - CAL_GAP };
            tip.beside(f, c, x + cell / 2.0, ty);
        }
    }
}

// Treemap

const TREEMAP_H: f32 = 240.0;

#[derive(Clone)]
struct Treemap<'a> {
    t: &'a spec::Treemap,
}

impl Treemap<'_> {
    fn tiles(&self, w: f32) -> Vec<spec::Tile> {
        spec::treemap(&self.t.items.iter().map(|it| it.value).collect::<Vec<_>>(), w as f64, TREEMAP_H as f64)
    }
}

impl Plot for Treemap<'_> {
    fn height(&self, _: f32) -> f32 {
        TREEMAP_H
    }

    fn pick(&self, w: f32, p: Point) -> Option<usize> {
        let (x, y) = (p.x as f64, p.y as f64);
        self.tiles(w).iter().find(|t| x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h).map(|t| t.i)
    }

    fn draw(&self, f: &mut Frame, c: &Colors, at: Option<usize>) {
        let items = &self.t.items;
        let unit = self.t.unit.as_deref();
        let max = items.iter().map(|it| it.value).fold(0.0, f64::max);
        let total: f64 = items.iter().map(|it| it.value).sum();
        let tiles = self.tiles(f.width());
        for t in &tiles {
            let it = &items[t.i];
            let (x, y, w, h) = (t.x as f32, t.y as f32, t.w as f32, t.h as f32);
            let fill = alpha(c.series[0], 0.1 + 0.4 * (it.value / max) as f32);
            rounded(f, x + 1.0, y + 1.0, w - 2.0, h - 2.0, 4.0, fill);
            if at == Some(t.i) {
                f.stroke(
                    &Path::rounded_rectangle(
                        Point::new(x + 1.0, y + 1.0),
                        Size::new((w - 2.0).max(0.0), (h - 2.0).max(0.0)),
                        4.0.into(),
                    ),
                    Stroke::default().with_color(c.text).with_width(1.5),
                );
            }
            if w >= 56.0 && h >= 30.0 {
                let cut = ((w - 12.0) / (0.55 * FS_SM)).floor() as usize;
                f.fill_text(Text {
                    size: FS_SM.into(),
                    align_y: Vertical::Top,
                    ..words(cut_to(&it.label, cut), x + 6.0, y + 6.0, c.text)
                });
                if h >= 44.0 {
                    let value = cut_to(&format(it.value, unit, false), cut);
                    f.fill_text(Text { align_y: Vertical::Top, ..words(value, x + 6.0, y + 22.0, c.muted) });
                }
            }
        }
        if let Some(t) = at.and_then(|i| tiles.iter().find(|t| t.i == i)) {
            let it = &items[t.i];
            let share = format!("{}%", (it.value / total * 100.0).round());
            let tip = Tip::default().muted(it.label.clone()).row(None, format(it.value, unit, false), Some(share));
            let s = tip.size();
            let (x, y, h) = (t.x as f32, t.y as f32, t.h as f32);
            let ty = if y + h + 4.0 + s.height <= TREEMAP_H { y + h + 4.0 } else { y - 4.0 - s.height };
            tip.draw(f, c, Point::new(x.min(f.width() - s.width), ty));
        }
    }
}

// Offers

#[derive(Clone)]
struct Offers<'a> {
    o: &'a spec::Offers,
}

struct OffersAt {
    left: f32,
    plot_w: f32,
    bottom: f64,
    top: f64,
    ticks: Vec<f64>,
}

impl Offers<'_> {
    fn at(&self, w: f32) -> OffersAt {
        let mut values: Vec<f64> = self.o.offers.iter().map(|o| o.price).collect();
        values.extend(self.o.limit);
        let (lo, hi) = range_of(&values);
        let ticks = nice_ticks(lo, hi, 4);
        let left =
            ticks.iter().map(|t| est(&format(*t, self.o.unit.as_deref(), true), FS_XS)).fold(0.0, f32::max) + 8.0;
        OffersAt {
            left,
            plot_w: (w - left - 10.0).max(40.0),
            bottom: ticks[0],
            top: *ticks.last().unwrap_or(&1.0),
            ticks,
        }
    }
}

impl OffersAt {
    fn x(&self, i: usize, n: usize) -> f32 {
        self.left + if n == 1 { self.plot_w / 2.0 } else { i as f32 * self.plot_w / (n - 1) as f32 }
    }

    fn y(&self, v: f64) -> f32 {
        let span = if self.top == self.bottom { 1.0 } else { self.top - self.bottom };
        TOP + PLOT_H - ((v - self.bottom) / span) as f32 * PLOT_H
    }
}

impl Plot for Offers<'_> {
    fn height(&self, _: f32) -> f32 {
        HEIGHT
    }

    fn pick(&self, w: f32, p: Point) -> Option<usize> {
        let a = self.at(w);
        let n = self.o.offers.len();
        if n == 1 {
            return Some(0);
        }
        Some(((p.x - a.left) / a.plot_w * (n - 1) as f32).round().clamp(0.0, (n - 1) as f32) as usize)
    }

    fn draw(&self, f: &mut Frame, c: &Colors, at: Option<usize>) {
        let o = self.o;
        let a = self.at(f.width());
        let n = o.offers.len();
        let unit = o.unit.as_deref();
        let side = |by: Side| if by == Side::You { 0 } else { 1 };
        for t in &a.ticks {
            line(f, Point::new(a.left, a.y(*t)), Point::new(a.left + a.plot_w, a.y(*t)), grid(c));
            f.fill_text(right(words(format(*t, unit, true), a.left - 8.0, a.y(*t), c.muted)));
        }
        let step = n.div_ceil(((a.plot_w / 28.0).floor() as usize).max(1)).max(1);
        for i in 0..n {
            if i % step == 0 || i == n - 1 {
                f.fill_text(centred(words((i + 1).to_string(), a.x(i, n), HEIGHT - 9.0, c.muted)));
            }
        }
        if let Some(limit) = o.limit {
            let y = a.y(limit);
            dashed(f, Point::new(a.left, y), Point::new(a.left + a.plot_w, y), c.text_2);
            f.fill_text(right(words("Limit", a.left + a.plot_w, y - 7.0, c.text_2)));
        }
        for by in [Side::You, Side::Them] {
            let points = o.offers.iter().enumerate().filter(|(_, of)| of.by == by);
            polyline(f, points.map(|(i, of)| Some(Point::new(a.x(i, n), a.y(of.price)))), c.series[side(by)]);
        }
        for (i, of) in o.offers.iter().enumerate() {
            let r = if at == Some(i) { 5.0 } else { 3.5 };
            dot(f, c, Point::new(a.x(i, n), a.y(of.price)), r, dim(c.series[side(of.by)], lit(at, i)));
        }
        if let Some(of) = at.and_then(|i| o.offers.get(i)) {
            let i = at.unwrap_or(0);
            let who = if of.by == Side::You { "You".to_string() } else { o.them_name().to_string() };
            let mut tip = Tip::default().muted(format!("Turn {}", i + 1)).row(
                Some(c.series[side(of.by)]),
                format(of.price, unit, false),
                Some(who),
            );
            if let Some(note) = of.note.as_ref().filter(|n| !n.is_empty()) {
                tip = tip.muted(note.clone());
            }
            tip.beside(f, c, a.x(i, n), 0.0);
        }
    }
}

// Widgets

fn cell_style(background: Option<Color>, radius: f32) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: background.map(Into::into),
        border: Border { radius: radius.into(), ..Border::default() },
        ..Default::default()
    }
}

const LABEL_W: f32 = 120.0;
const MATRIX_CELL: f32 = 80.0;

/// A value without its unit, which the column's header carries.
fn bare(v: f64, unit: Option<&str>) -> String {
    let s = format(v, unit, false);
    match unit {
        None | Some("") => s,
        Some(u) => s.strip_suffix(&format!(" {u}")).map_or_else(|| s.replacen(u, "", 1), str::to_string),
    }
}

fn matrix<'a, M: 'a>(m: &'a spec::Matrix) -> Element<'a, M> {
    let mut head = row![Space::new().width(LABEL_W)].spacing(2).align_y(Alignment::End);
    for col in &m.columns {
        head = head.push(
            column![text(col.name.as_str()).size(FS_XS).font(theme::SEMIBOLD).style(tone(|c| c.text_2))]
                .push(col.unit.as_deref().map(|u| text(u).size(FS_XS).style(tone(|c| c.muted))))
                .align_x(Alignment::End)
                .width(MATRIX_CELL)
                .padding([2.0, SP]),
        );
    }
    let mut grid_rows = column![head].spacing(2);
    for (ri, name) in m.rows.iter().enumerate() {
        let mut r = row![text(name.as_str()).size(FS_XS).style(tone(|c| c.text)).width(LABEL_W)]
            .spacing(2)
            .align_y(Alignment::Center);
        for (ci, col) in m.columns.iter().enumerate() {
            let value = m.values[ri][ci];
            let shade = m.shade(ri, ci);
            let label = text(value.map_or("–".to_string(), |v| bare(v, col.unit.as_deref())))
                .size(FS_XS)
                .style(if value.is_some() { tone(|c| c.text) } else { tone(|c| c.soft) });
            r = r.push(container(label).align_x(Alignment::End).width(MATRIX_CELL).padding([4.0, SP]).style(
                move |t: &Theme| {
                    let c = theme::colors(t);
                    cell_style(shade.map(|s| alpha(c.series[0], 0.08 + 0.57 * s as f32)), R_XS)(t)
                },
            ));
        }
        grid_rows = grid_rows.push(r);
    }
    scrollable(grid_rows)
        .direction(scrollable::Direction::Horizontal(scrollable::Scrollbar::default().width(4).scroller_width(4)))
        .style(theme::scroll)
        .into()
}

fn compare<'a, M: 'a>(k: &'a spec::Compare) -> Element<'a, M> {
    let mut head = row![Space::new().width(LABEL_W)].spacing(2).align_y(Alignment::End);
    for name in &k.columns {
        head = head.push(
            container(text(name.as_str()).size(FS_XS).font(theme::SEMIBOLD).style(tone(|c| c.text_2)))
                .width(Length::Fill)
                .padding([2.0, SP]),
        );
    }
    let mut rows = column![head].spacing(2);
    for r in &k.rows {
        // A row that's the same for each says nothing about which to pick.
        let alike = r.alike();
        let mut line = row![text(r.label.as_str()).size(FS_XS).style(tone(|c| c.text_2)).width(LABEL_W)].spacing(2);
        for (ci, v) in r.values.iter().enumerate() {
            let best = r.best == Some(ci) && v.is_some();
            let label = text(v.as_deref().unwrap_or("–"))
                .size(FS_XS)
                .font(if best { theme::SEMIBOLD } else { theme::TEXT })
                .style(if v.is_none() {
                    tone(|c| c.soft)
                } else if alike {
                    tone(|c| c.muted)
                } else {
                    tone(|c| c.text)
                });
            line = line.push(container(label).width(Length::Fill).padding([4.0, SP]).style(move |t: &Theme| {
                let c = theme::colors(t);
                cell_style(best.then(|| alpha(c.series[0], 0.22)), R_XS)(t)
            }));
        }
        rows = rows.push(line);
    }
    rows.into()
}

fn meter<'a, M: 'a>(m: &'a spec::Meter) -> Element<'a, M> {
    let mut rows = column![].spacing(SP_MD);
    for r in &m.rows {
        let value =
            format!("{} / {}", format(r.value, m.unit.as_deref(), false), format(r.max, m.unit.as_deref(), false));
        let full = ((r.value / r.max).clamp(0.0, 1.0) * 1000.0).round() as u16;
        let warning = r.warning();
        let filled =
            container(Space::new()).width(Length::FillPortion(full.max(1))).height(8).style(move |t: &Theme| {
                let c = theme::colors(t);
                cell_style(Some(if warning { c.danger } else { c.series[0] }), PILL)(t)
            });
        let mut track = row![];
        if full > 0 {
            track = track.push(filled);
        }
        if full < 1000 {
            track = track.push(Space::new().width(Length::FillPortion(1000 - full)));
        }
        let track = container(track).width(Length::Fill).height(8).style(|t: &Theme| {
            let c = theme::colors(t);
            cell_style(Some(grid(c)), PILL)(t)
        });
        rows = rows.push(
            column![
                row![
                    text(r.label.as_str()).size(FS_SM).width(Length::Fill),
                    text(value).size(FS_SM).style(tone(|c| c.text_2))
                ]
                .spacing(SP_MD),
                track
            ]
            .spacing(SP / 2.0),
        );
    }
    rows.into()
}

/// A listing's photo through the brain, or an empty tile for one it won't fetch or hasn't yet.
fn photo<'a, M: 'a>(url: Option<&str>, w: f32, ctx: Ctx<'a, M>) -> Element<'a, M> {
    let h = w * 3.0 / 4.0;
    if let Some(handle) = url.filter(|u| spec::listing_photo(u)).and_then(|u| (ctx.photo)(u)) {
        return image(handle).width(w).height(h).content_fit(iced::ContentFit::Cover).border_radius(R_MD).into();
    }
    container(Space::new())
        .width(w)
        .height(h)
        .style(|t: &Theme| {
            let c = theme::colors(t);
            container::Style {
                background: Some(grid(c).into()),
                border: Border { color: c.line, width: 1.0, radius: R_MD.into() },
                ..Default::default()
            }
        })
        .into()
}

fn link_style(t: &Theme, status: button::Status) -> button::Style {
    let c = theme::colors(t);
    button::Style {
        background: matches!(status, button::Status::Hovered | button::Status::Pressed)
            .then(|| alpha(c.text, 0.06).into()),
        text_color: c.text,
        border: Border { radius: R_MD.into(), ..Border::default() },
        ..button::Style::default()
    }
}

fn sideways<'a, M: 'a>(content: impl Into<Element<'a, M>>) -> Element<'a, M> {
    scrollable(container(content).padding(iced::Padding::default().bottom(SP)))
        .direction(scrollable::Direction::Horizontal(scrollable::Scrollbar::default().width(4).scroller_width(4)))
        .style(theme::scroll)
        .into()
}

const CARD_W: f32 = 168.0;

fn listings<'a, M: Clone + 'a>(l: &'a spec::Listings, ctx: Ctx<'a, M>) -> Element<'a, M> {
    let mut cards = row![].spacing(SP_MD);
    for it in &l.items {
        let place = it.place();
        let card = column![
            photo(it.photo.as_deref(), CARD_W, ctx),
            Space::new().height(2),
            // Two lines of it, about.
            text(cut_to(&it.title, 48)).size(FS_SM).line_height(1.35),
        ]
        .push(it.price.map(|p| text(format(p, l.unit.as_deref(), false)).size(FS_MD).font(theme::SEMIBOLD)))
        .push((!place.is_empty()).then(|| text(cut_to(&place, 28)).size(FS_XS).style(tone(|c| c.muted))))
        .spacing(2)
        .width(CARD_W);
        cards = cards.push(button(card).padding(0).style(link_style).on_press((ctx.open)(it.url.clone())));
    }
    sideways(cards)
}

const GALLERY_W: f32 = 280.0;

fn gallery<'a, M: Clone + 'a>(g: &'a spec::Gallery, ctx: Ctx<'a, M>) -> Element<'a, M> {
    let mut photos = row![].spacing(SP);
    for url in &g.photos {
        let shown = photo(Some(url), GALLERY_W, ctx);
        photos = photos.push(match &g.url {
            Some(link) => button(shown).padding(0).style(link_style).on_press((ctx.open)(link.clone())).into(),
            None => shown,
        });
    }
    sideways(photos)
}
