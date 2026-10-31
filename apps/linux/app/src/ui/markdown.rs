// Bot replies as Markdown, parsed once per text and drawn in the web's type.
use std::collections::{HashMap, HashSet};

use iced::widget::markdown::{self, Settings, Style, Text, Uri};
use iced::widget::{container, scrollable};
use iced::{Alignment, Element, Font, Length, Padding, border, font, padding};
use iced_selection::rich_text;

use super::theme::{self, CODE, FS_TEXT, R_XS};

/// The texts shown, parsed: one parses again only when its text changes.
#[derive(Default)]
pub struct Cache {
    parsed: HashMap<String, markdown::Content>,
}

impl Cache {
    /// Keeps these texts parsed and lets the rest go.
    pub fn keep<'s>(&mut self, texts: impl IntoIterator<Item = &'s str>) {
        let wanted: HashSet<&str> = texts.into_iter().filter(|t| !t.is_empty()).collect();
        self.parsed.retain(|k, _| wanted.contains(k.as_str()));
        for t in wanted {
            if !self.parsed.contains_key(t) {
                self.parsed.insert(t.to_string(), markdown::Content::parse(t));
            }
        }
    }

    pub fn get(&self, text: &str) -> Option<&markdown::Content> {
        self.parsed.get(text)
    }
}

pub fn settings(dark: bool) -> Settings {
    let c = if dark { &theme::DARK } else { &theme::LIGHT };
    let style = Style {
        font: theme::TEXT,
        inline_code_highlight: markdown::Highlight { background: c.surface_2.into(), border: border::rounded(R_XS) },
        inline_code_padding: padding::left(4).right(4),
        inline_code_color: c.text,
        inline_code_font: CODE,
        code_block_font: CODE,
        link_color: c.hue,
    };
    let mut s = Settings::with_text_size(FS_TEXT, style);
    // A browser's own heading sizes, as the web's chat keeps them.
    s.h1_size = (FS_TEXT * 2.0).into();
    s.h2_size = (FS_TEXT * 1.5).into();
    s.h3_size = (FS_TEXT * 1.17).into();
    s.h4_size = FS_TEXT.into();
    s.code_size = 12.0.into();
    // Also a list's indent, either side of its bullet: 8 + 8 and the bullet make the web's 20.
    s.spacing = 8.0.into();
    s
}

struct Viewer;

impl<'a> markdown::Viewer<'a, Uri> for Viewer {
    fn on_link_click(url: Uri) -> Uri {
        url
    }

    fn paragraph(&self, settings: Settings, text: &Text) -> Element<'a, Uri> {
        rich_text(text.spans(settings.style))
            .size(settings.text_size)
            .line_height(1.5)
            .on_link_click(Self::on_link_click)
            .style(theme::selectable)
            .into()
    }

    fn heading(
        &self,
        settings: Settings,
        level: &'a markdown::HeadingLevel,
        text: &'a Text,
        _: usize,
    ) -> Element<'a, Uri> {
        use markdown::HeadingLevel::*;
        let size = match level {
            H1 => settings.h1_size,
            H2 => settings.h2_size,
            H3 => settings.h3_size,
            _ => settings.h4_size,
        };
        container(
            rich_text(text.spans(Style { font: Font { weight: font::Weight::Bold, ..theme::TEXT }, ..settings.style }))
                .size(size)
                .on_link_click(Self::on_link_click)
                .style(theme::selectable),
        )
        .padding(Padding::default().top(4))
        .into()
    }

    fn unordered_list(&self, settings: Settings, bullets: &'a [markdown::Bullet]) -> Element<'a, Uri> {
        list(self, settings, bullets.iter().map(|b| ("•".to_string(), b)))
    }

    fn ordered_list(&self, settings: Settings, start: u64, bullets: &'a [markdown::Bullet]) -> Element<'a, Uri> {
        list(self, settings, bullets.iter().enumerate().map(|(i, b)| (format!("{}.", start + i as u64), b)))
    }

    fn code_block(&self, settings: Settings, _: Option<&'a str>, _: &'a str, lines: &'a [Text]) -> Element<'a, Uri> {
        let body = iced::widget::column(lines.iter().map(|line| {
            rich_text(line.spans(Style { font: CODE, ..settings.style }))
                .size(settings.code_size)
                .on_link_click(Self::on_link_click)
                .style(theme::selectable)
                .into()
        }));
        container(
            scrollable(container(body).padding([8, 12]))
                .direction(scrollable::Direction::Horizontal(
                    scrollable::Scrollbar::default().width(4).scroller_width(4),
                ))
                .style(theme::scroll),
        )
        .width(Length::Fill)
        .style(theme::code_block)
        .into()
    }
}

/// A list as the web lays one out: the markers in a 20px margin, the items 4px apart.
fn list<'a>(
    viewer: &Viewer,
    settings: Settings,
    bullets: impl Iterator<Item = (String, &'a markdown::Bullet)>,
) -> Element<'a, Uri> {
    iced::widget::column(bullets.map(|(marker, bullet)| {
        let items = match bullet {
            markdown::Bullet::Point { items } | markdown::Bullet::Task { items, .. } => items,
        };
        iced::widget::row![
            container(iced::widget::text(marker).size(settings.text_size).line_height(1.5))
                .width(20)
                .padding(Padding::default().right(5))
                .align_x(Alignment::End),
            markdown::view_with(items, settings, viewer)
        ]
        .into()
    }))
    .spacing(4)
    .into()
}

/// Markdown; a link's click makes `on_link(url)`.
pub fn view<'a, M: 'a>(content: &'a markdown::Content, dark: bool, on_link: fn(Uri) -> M) -> Element<'a, M> {
    markdown::view_with(content.items(), settings(dark), &Viewer).map(on_link)
}
