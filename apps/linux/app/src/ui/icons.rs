// Material Symbols Rounded and the bots' marks, drawn as SVG and tinted from the theme.
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use iced::widget::{Svg, svg};
use iced::{Color, Length, Theme};

pub use super::icon_paths::Icon;
use super::icon_paths::bot_paths;
use super::theme::{self, Colors};

const HAT: &str = r#"<g fill="none" stroke="black" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" transform="matrix(40 0 0 40 0 -960)">{}</g>"#;
const HAT_OUTLINED: &str = r#"<path d="M7 15.5V7c0-1.7 2.2-3 5-3s5 1.3 5 3v8.5"/><path d="M7 12.5c1.4.6 3.1 1 5 1s3.6-.4 5-1"/><path d="M2.5 16c1.4 2.1 5.2 3.5 9.5 3.5s8.1-1.4 9.5-3.5"/>"#;
const HAT_FILLED: &str = r#"<path fill="black" d="M7 15.5V7c0-1.7 2.2-3 5-3s5 1.3 5 3v8.5z"/><path d="M2.5 16c1.4 2.1 5.2 3.5 9.5 3.5s8.1-1.4 9.5-3.5"/>"#;

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
