// Material Symbols Rounded and the bots' marks, drawn as SVG and tinted from the theme.
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use iced::widget::{Svg, container, stack, svg};
use iced::{Color, Element, Length, Theme};

pub use super::icon_paths::Icon;
use super::icon_paths::bot_paths;
use super::theme::{self, Colors};

const HAT: &str = r#"<g fill="none" stroke="black" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" transform="matrix(40 0 0 40 0 -960)">{}</g>"#;
const HAT_OUTLINED: &str = r#"<path d="M7 15.5V7c0-1.7 2.2-3 5-3s5 1.3 5 3v8.5"/><path d="M7 12.5c1.4.6 3.1 1 5 1s3.6-.4 5-1"/><path d="M2.5 16c1.4 2.1 5.2 3.5 9.5 3.5s8.1-1.4 9.5-3.5"/>"#;
const HAT_FILLED: &str = r#"<path fill="black" d="M7 15.5V7c0-1.7 2.2-3 5-3s5 1.3 5 3v8.5z"/><path d="M2.5 16c1.4 2.1 5.2 3.5 9.5 3.5s8.1-1.4 9.5-3.5"/>"#;

/// The web's `.brand-mark` shape, a scalloped circle, in percent.
const SCALLOP: &str = "100,50 98.2,56.4 93.9,61.8 95,68.6 93.3,75 88.6,79.6 82.2,82.2 79.6,88.6 75,93.3 68.6,95 61.8,93.9 56.4,98.2 50,100 43.6,98.2 38.2,93.9 31.4,95 25,93.3 20.4,88.6 17.8,82.2 11.4,79.6 6.7,75 5,68.6 6.1,61.8 1.8,56.4 0,50 1.8,43.6 6.1,38.2 5,31.4 6.7,25 11.4,20.4 17.8,17.8 20.4,11.4 25,6.7 31.4,5 38.2,6.1 43.6,1.8 50,0 56.4,1.8 61.8,6.1 68.6,5 75,6.7 79.6,11.4 82.2,17.8 88.6,20.4 93.3,25 95,31.4 93.9,38.2 98.2,43.6";

static HANDLES: LazyLock<Mutex<HashMap<(String, bool), svg::Handle>>> = LazyLock::new(Default::default);

fn handle(key: &str, filled: bool, body: impl FnOnce() -> String) -> svg::Handle {
    let mut cache = HANDLES.lock().unwrap();
    cache
        .entry((key.to_string(), filled))
        .or_insert_with(|| {
            let doc = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960">{}</svg>"#, body());
            svg::Handle::from_memory(doc.into_bytes())
        })
        .clone()
}

fn path(d: &str) -> String {
    format!(r#"<path d="{d}"/>"#)
}

fn tinted<'a>(h: svg::Handle, size: f32, tone: impl Fn(&Theme) -> Color + 'a) -> Svg<'a> {
    svg(h)
        .width(Length::Fixed(size))
        .height(Length::Fixed(size))
        .style(move |t: &Theme, _| svg::Style { color: Some(tone(t)) })
}

/// An icon in one of the theme's colours.
pub fn icon<'a>(i: Icon, size: f32, tone: fn(&Colors) -> Color) -> Svg<'a> {
    let (outlined, _) = i.paths();
    tinted(handle(&format!("{i:?}"), false, || path(outlined)), size, move |t| tone(theme::colors(t)))
}

/// The filled one, for what's chosen.
pub fn filled<'a>(i: Icon, size: f32, tone: fn(&Colors) -> Color) -> Svg<'a> {
    let (_, solid) = i.paths();
    tinted(handle(&format!("{i:?}"), true, || path(solid)), size, move |t| tone(theme::colors(t)))
}

pub fn hat<'a>(size: f32, solid: bool, tone: impl Fn(&Theme) -> Color + 'a) -> Svg<'a> {
    let h = handle("hat", solid, || HAT.replace("{}", if solid { HAT_FILLED } else { HAT_OUTLINED }));
    tinted(h, size, tone)
}

/// Hatbot's mark: the hat on the accent's scalloped badge, as the web's rail shows it.
pub fn brand<'a, M: 'a>(size: f32) -> Element<'a, M> {
    static SHAPE: LazyLock<svg::Handle> = LazyLock::new(|| {
        let doc = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="{SCALLOP}"/></svg>"#
        );
        svg::Handle::from_memory(doc.into_bytes())
    });
    let shape = tinted(SHAPE.clone(), size, |t| theme::colors(t).hue);
    let hat = hat(size * 0.55, false, |t| theme::colors(t).on_hue);
    stack![shape, container(hat).center(size)].into()
}

/// A bot's mark in its own colour; one this app doesn't know is the hat.
pub fn bot<'a>(icon_name: &str, color: &str, size: f32, solid: bool) -> Svg<'a> {
    let color = color.to_string();
    let tone = move |t: &Theme| theme::bot_color(t, &color);
    match bot_paths(icon_name) {
        Some((outlined, full)) => {
            let d = if solid { full } else { outlined };
            tinted(handle(icon_name, solid, || path(d)), size, tone)
        }
        None => hat(size, solid, tone),
    }
}

pub fn text(c: &Colors) -> Color {
    c.text
}
pub fn text_2(c: &Colors) -> Color {
    c.text_2
}
pub fn muted(c: &Colors) -> Color {
    c.muted
}
pub fn hue(c: &Colors) -> Color {
    c.hue
}
pub fn on_hue(c: &Colors) -> Color {
    c.on_hue
}
pub fn danger(c: &Colors) -> Color {
    c.danger
}
pub fn success(c: &Colors) -> Color {
    c.success
}
