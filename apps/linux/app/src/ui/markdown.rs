// Bot replies as Markdown, parsed once per text and drawn in the web's type.
use std::collections::{HashMap, HashSet};

use iced::widget::markdown::{self, Settings, Style, Text, Uri};
use iced::widget::{container, rich_text, scrollable};
use iced::{Element, Length, Padding, border, padding};

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
        inline_code_padding: padding::left(3).right(3),
        inline_code_color: c.text,
        inline_code_font: CODE,
        code_block_font: CODE,
        link_color: c.hue,
    };
    let mut s = Settings::with_text_size(FS_TEXT, style);
    s.h1_size = 22.0.into();
    s.h2_size = 19.0.into();
    s.h3_size = 17.0.into();
    s.h4_size = FS_TEXT.into();
    s.code_size = 13.5.into();
    s.spacing = 10.0.into();
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
            rich_text(text.spans(settings.style)).size(size).font(theme::SEMIBOLD).on_link_click(Self::on_link_click),
        )
        .padding(Padding::default().top(4))
        .into()
    }

    fn code_block(&self, settings: Settings, _: Option<&'a str>, _: &'a str, lines: &'a [Text]) -> Element<'a, Uri> {
        let body = iced::widget::column(lines.iter().map(|line| {
            rich_text(line.spans(settings.style))
                .font(CODE)
                .size(settings.code_size)
                .on_link_click(Self::on_link_click)
                .into()
        }));
        container(
            scrollable(container(body).padding(12))
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

/// Markdown; a link's click makes `on_link(url)`.
pub fn view<'a, M: 'a>(content: &'a markdown::Content, dark: bool, on_link: fn(Uri) -> M) -> Element<'a, M> {
    markdown::view_with(content.items(), settings(dark), &Viewer).map(on_link)
}
