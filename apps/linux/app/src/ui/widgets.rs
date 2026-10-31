// The small pieces every page is built from, in the web's sizes.
use iced::widget::{
    Space, button, column, container, pick_list, row, scrollable, text, text_editor, text_input, tooltip,
};
use iced::{Alignment, Color, Element, Length, Padding, Theme};

use super::icons::{self, Icon};
use super::theme::{
    self, Colors, FS_LG, FS_MD, FS_SM, FS_TEXT, FS_XL, H, H_SM, NAV_ICON, PAGE, SP, SP_LG, SP_MD, SP_XL, SP_XS,
};

pub fn tone(f: fn(&Colors) -> Color) -> impl Fn(&Theme) -> text::Style {
    move |t| text::Style { color: Some(f(theme::colors(t))) }
}

/// Body text, which can be selected and copied, as on the web.
pub fn body<'a>(s: impl text::IntoFragment<'a>) -> iced_selection::Text<'a> {
    iced_selection::text(s).size(FS_TEXT).line_height(1.5).style(theme::selectable)
}

pub fn small<'a>(s: impl text::IntoFragment<'a>) -> text::Text<'a> {
    text(s).size(FS_MD).style(tone(|c| c.muted))
}

pub fn tiny<'a>(s: impl text::IntoFragment<'a>) -> text::Text<'a> {
    text(s).size(FS_SM).style(tone(|c| c.muted))
}

pub fn strong<'a>(s: impl text::IntoFragment<'a>) -> text::Text<'a> {
    text(s).size(FS_TEXT).font(theme::SEMIBOLD)
}

pub fn title<'a>(s: impl text::IntoFragment<'a>) -> text::Text<'a> {
    text(s).size(FS_XL).font(theme::TEXT)
}

pub fn heading<'a>(s: impl text::IntoFragment<'a>) -> text::Text<'a> {
    text(s).size(FS_MD).font(theme::MEDIUM).style(tone(|c| c.hue))
}

pub fn error<'a>(s: impl text::IntoFragment<'a>) -> text::Text<'a> {
    text(s).size(FS_MD).style(tone(|c| c.danger))
}

fn label<'a>(s: impl text::IntoFragment<'a>) -> text::Text<'a> {
    text(s).size(FS_MD).font(theme::MEDIUM)
}

pub type Style = fn(&Theme, button::Status) -> button::Style;

/// A button the web's `.btn` way: a pill with a label.
pub fn btn<'a, M: Clone + 'a>(s: impl text::IntoFragment<'a>, style: Style, on: Option<M>) -> button::Button<'a, M> {
    button(container(label(s)).center_y(Length::Fill)).height(H).padding([0.0, SP_LG]).style(style).on_press_maybe(on)
}

/// A pill that shares a row with others, its label centred.
pub fn btn_wide<'a, M: Clone + 'a>(
    s: impl text::IntoFragment<'a>,
    style: Style,
    on: Option<M>,
) -> button::Button<'a, M> {
    button(container(label(s)).center(Length::Fill))
        .width(Length::Fill)
        .height(H)
        .padding([0.0, SP_LG])
        .style(style)
        .on_press_maybe(on)
}

pub fn btn_sm<'a, M: Clone + 'a>(s: impl text::IntoFragment<'a>, style: Style, on: Option<M>) -> button::Button<'a, M> {
    button(container(label(s)).center_y(Length::Fill))
        .height(H_SM)
        .padding([0.0, SP_MD])
        .style(style)
        .on_press_maybe(on)
}

/// A pill with an icon before its label.
pub fn btn_icon<'a, M: Clone + 'a>(
    i: Icon,
    s: impl text::IntoFragment<'a>,
    style: Style,
    ink: fn(&Colors) -> Color,
    on: Option<M>,
) -> button::Button<'a, M> {
    button(row![icons::icon(i, 18.0, ink), label(s)].spacing(SP).align_y(Alignment::Center).height(Length::Fill))
        .height(H)
        .padding(Padding::default().left(SP_MD).right(SP_LG))
        .style(style)
        .on_press_maybe(on)
}

/// A round icon button, the toolbar's `.tb-btn`, with its name as a tooltip.
pub fn icon_btn<'a, M: Clone + 'a>(i: Icon, name: &'a str, on: Option<M>) -> Element<'a, M> {
    icon_btn_styled(i, name, on, false)
}

pub fn icon_btn_styled<'a, M: Clone + 'a>(i: Icon, name: &'a str, on: Option<M>, lit: bool) -> Element<'a, M> {
    icon_btn_with(i, name, on, lit, NAV_ICON)
}

/// One with a smaller glyph, as a row's own buttons have.
pub fn icon_btn_sized<'a, M: Clone + 'a>(i: Icon, name: &'a str, on: Option<M>, size: f32) -> Element<'a, M> {
    icon_btn_with(i, name, on, false, size)
}

fn icon_btn_with<'a, M: Clone + 'a>(i: Icon, name: &'a str, on: Option<M>, lit: bool, size: f32) -> Element<'a, M> {
    let glyph = if lit { icons::filled(i, size, icons::text) } else { icons::icon(i, size, icons::text_2) };
    let b = button(container(glyph).center(Length::Fill))
        .width(H)
        .height(H)
        .padding(0)
        .style(theme::tb_btn(lit))
        .on_press_maybe(on);
    tooltip(b, container(text(name).size(FS_SM)).padding([4, 8]).style(theme::toast), tooltip::Position::Bottom).into()
}

pub fn input<'a, M: Clone + 'a>(
    placeholder: &str,
    value: &str,
    on: impl Fn(String) -> M + 'a,
) -> text_input::TextInput<'a, M> {
    text_input(placeholder, value).on_input(on).padding([11, SP_MD as u16]).size(FS_MD).style(theme::input)
}

/// A label above its field.
pub fn field<'a, M: 'a>(name: &'a str, input: impl Into<Element<'a, M>>) -> Element<'a, M> {
    column![text(name).size(FS_MD).font(theme::MEDIUM).style(tone(|c| c.text_2)), input.into()].spacing(SP).into()
}

/// A setting's row: its name, what it does, and a switch.
pub fn switch_row<'a, M: Clone + 'a>(
    name: impl text::IntoFragment<'a>,
    about: Option<&'a str>,
    on: bool,
    change: Option<impl Fn(bool) -> M + 'a>,
) -> Element<'a, M> {
    let words = column![text(name).size(FS_LG)].push(about.map(small)).spacing(1).width(Length::Fill);
    row![words, switch(on, change.map(|f| f(!on)))].spacing(SP_LG).align_y(Alignment::Center).into()
}

/// Expressive's switch, at the web's size: iced's toggler can't take its proportions.
pub fn switch<'a, M: Clone + 'a>(on: bool, change: Option<M>) -> Element<'a, M> {
    let size = if on { 24.0 } else { 16.0 };
    let thumb = container(Space::new()).width(size).height(size).style(move |t: &Theme| {
        let c = theme::colors(t);
        container::Style {
            background: Some((if on { c.on_hue } else { c.outline }).into()),
            border: iced::border::rounded(theme::PILL),
            ..Default::default()
        }
    });
    let left = if on { 22.0 } else { 6.0 };
    let enabled = change.is_some();
    button(container(thumb).center_y(Length::Fill).padding(Padding::default().left(left)))
        .width(52)
        .height(32)
        .padding(0)
        .style(move |t, status| theme::switch_track(t, status, on, enabled))
        .on_press_maybe(change)
        .into()
}

pub fn card<'a, M: 'a>(content: impl Into<Element<'a, M>>) -> container::Container<'a, M> {
    container(content).padding(SP_LG).width(Length::Fill).style(theme::card)
}

/// A page's body: centred at the reading width, scrolling.
pub fn page<'a, M: 'a>(content: impl Into<Element<'a, M>>) -> Element<'a, M> {
    page_of(PAGE, content)
}

/// A page at reading width, the web's `.page.narrow`.
pub fn page_narrow<'a, M: 'a>(content: impl Into<Element<'a, M>>) -> Element<'a, M> {
    page_of(theme::MEASURE, content)
}

fn page_of<'a, M: 'a>(width: f32, content: impl Into<Element<'a, M>>) -> Element<'a, M> {
    scrollable(
        container(container(content).max_width(width).width(Length::Fill).padding(Padding {
            top: theme::SP_PAGE,
            right: SP_XL,
            bottom: theme::SP_2XL,
            left: SP_XL,
        }))
        .center_x(Length::Fill),
    )
    .style(theme::scroll)
    .height(Length::Fill)
    .into()
}

/// What shows where there's nothing yet.
pub fn empty<'a, M: 'a>(s: impl text::IntoFragment<'a>) -> Element<'a, M> {
    container(text(s).size(FS_MD).style(tone(|c| c.muted)).align_x(Alignment::Center))
        .center_x(Length::Fill)
        .padding([theme::SP_2XL, 0.0])
        .into()
}

pub fn gap<'a, M: 'a>(h: f32) -> Element<'a, M> {
    Space::new().height(h).into()
}

pub fn fill<'a, M: 'a>() -> Element<'a, M> {
    Space::new().width(Length::Fill).into()
}

pub fn rule<'a, M: 'a>() -> Element<'a, M> {
    container(Space::new()).height(1).width(Length::Fill).style(theme::line).into()
}

/// A count in the accent's pill.
pub fn count<'a, M: 'a>(n: usize) -> Element<'a, M> {
    container(container(text(n.to_string()).size(theme::FS_XS).font(theme::MEDIUM)).center_x(Length::Shrink))
        .center_y(18)
        .padding([0.0, theme::SP_XS])
        .width(Length::Shrink)
        .style(theme::badge)
        .into()
}

/// A choice between a few views, as the web's segmented chips.
pub fn segmented<'a, M: Clone + 'a, V: Copy + PartialEq + 'a>(
    options: &[(&'a str, V)],
    selected: V,
    on: impl Fn(V) -> M,
) -> Element<'a, M> {
    let mut r = row![];
    for (name, v) in options {
        r = r.push(
            button(container(label(*name)).center_y(Length::Fill))
                .height(H)
                .padding([0.0, SP_LG])
                .style(theme::seg(*v == selected))
                .on_press(on(*v)),
        );
    }
    container(r).style(theme::seg_track).into()
}

/// A row in a list that opens something.
pub fn list_row<'a, M: Clone + 'a>(content: impl Into<Element<'a, M>>, on: Option<M>) -> Element<'a, M> {
    button(content).width(Length::Fill).padding([SP_MD, SP_LG]).style(theme::row(false)).on_press_maybe(on).into()
}

/// A name and its value, side by side.
pub fn labeled<'a, M: 'a>(name: &'a str, value: impl Into<Element<'a, M>>) -> Element<'a, M> {
    row![text(name).size(FS_MD).style(tone(|c| c.muted)).width(160), container(value).width(Length::Fill)]
        .spacing(SP_LG)
        .into()
}

/// A titled group on a page.
pub fn section<'a, M: 'a>(name: &'a str, content: impl Into<Element<'a, M>>) -> Element<'a, M> {
    column![heading(name), content.into()].spacing(SP_MD).into()
}

/// A titled list of setting rows, each on its own tile, as the web's `Group`.
pub fn group<'a, M: 'a>(name: &'a str, rows: Vec<Element<'a, M>>) -> Element<'a, M> {
    column![container(heading(name)).padding([0.0, SP_LG]), tiles(rows)].spacing(theme::SP_SM).into()
}

/// Setting rows, each on its own tile.
pub fn tiles<'a, M: 'a>(rows: Vec<Element<'a, M>>) -> Element<'a, M> {
    let n = rows.len();
    let mut tiles = column![].spacing(theme::SP_2XS);
    for (i, r) in rows.into_iter().enumerate() {
        tiles = tiles.push(
            // At least 56 tall, the web's `.row`.
            container(row![Space::new().height(H), r].align_y(Alignment::Center))
                .width(Length::Fill)
                .padding([SP, SP_LG])
                .style(theme::tile(i == 0, i + 1 == n)),
        );
    }
    tiles.into()
}

/// Rows that each open something, on their own tiles with a chevron, as the web's `LinkRow`s.
pub fn link_tiles<'a, M: Clone + 'a>(rows: Vec<(Element<'a, M>, M)>) -> Element<'a, M> {
    link_tiles_with(rows.into_iter().map(|(r, on)| (r, on, None)).collect())
}

/// Link rows, each with a control of its own after the chevron, such as a switch.
pub fn link_tiles_with<'a, M: Clone + 'a>(rows: Vec<(Element<'a, M>, M, Option<Element<'a, M>>)>) -> Element<'a, M> {
    let n = rows.len();
    let mut tiles = column![].spacing(theme::SP_2XS);
    for (i, (r, on, trailing)) in rows.into_iter().enumerate() {
        let (first, last) = (i == 0, i + 1 == n);
        let line = row![
            Space::new().height(H),
            container(r).width(Length::Fill).padding(Padding::default().right(SP_MD)),
            icons::icon(Icon::Chevron, 20.0, icons::text_2)
        ]
        .align_y(Alignment::Center);
        let link =
            button(line).width(Length::Fill).padding([SP, SP_LG]).style(theme::tile_btn(first, last)).on_press(on);
        tiles = tiles.push(match trailing {
            None => Element::from(link),
            Some(t) => container(row![link, t].spacing(SP_XS).align_y(Alignment::Center))
                .padding(Padding::default().right(SP_LG))
                .style(theme::tile(first, last))
                .into(),
        });
    }
    tiles.into()
}

/// A group with nothing in it yet: its words on a tile.
pub fn empty_tile<'a, M: 'a>(s: impl text::IntoFragment<'a>) -> Element<'a, M> {
    tiles(vec![text(s).size(FS_MD).style(tone(|c| c.text_2)).into()])
}

/// A link row's label, and what's beside it.
pub fn link_line<'a, M: 'a>(label: impl text::IntoFragment<'a>, value: Option<String>) -> Element<'a, M> {
    let mut r = row![text(label).size(theme::FS_LG).width(Length::Fill)].spacing(SP_LG).align_y(Alignment::Center);
    if let Some(v) = value {
        r = r.push(text(v).size(FS_MD).style(tone(|c| c.text_2)));
    }
    r.into()
}

/// A column of a `table`: its heading, its share of the width, and whether it's a number.
pub struct Column<'a> {
    pub name: &'a str,
    pub share: u16,
    pub num: bool,
}

/// The web's `.table`: headings over rows of tiles, each of which opens something.
pub fn table<'a, M: Clone + 'a>(cols: &[Column<'a>], rows: Vec<(Vec<Element<'a, M>>, M)>) -> Element<'a, M> {
    let cell = |e: Element<'a, M>, c: &Column<'a>| {
        let x = if c.num { Alignment::End } else { Alignment::Start };
        container(e).width(Length::FillPortion(c.share)).padding([0.0, SP_LG]).align_x(x).into()
    };
    let head = row(cols
        .iter()
        .map(|c| cell(text(c.name).size(FS_SM).font(theme::MEDIUM).style(tone(|c| c.text_2)).into(), c)))
    .height(36)
    .align_y(Alignment::Center);
    let n = rows.len();
    let mut body = column![].spacing(theme::SP_2XS);
    for (i, (cells, on)) in rows.into_iter().enumerate() {
        let line = row(cells.into_iter().zip(cols).map(|(e, c)| cell(e, c))).align_y(Alignment::Center);
        body = body.push(
            button(row![Space::new().height(H), line].align_y(Alignment::Center))
                .width(Length::Fill)
                .padding([SP, 0.0])
                .style(theme::tile_btn(i == 0, i + 1 == n))
                .on_press(on),
        );
    }
    column![head, body].spacing(theme::SP_2XS).into()
}

/// iced's editor keys, and Ctrl+Backspace and Ctrl+Delete take a word as a single-line field's do.
pub fn editor_keys<M>(content: &text_editor::Content, k: text_editor::KeyPress) -> Option<text_editor::Binding<M>> {
    use iced::keyboard::{Key, key::Named};
    use text_editor::{Binding, Motion};
    if k.modifiers.jump() && content.cursor().selection.is_none() {
        match k.key {
            Key::Named(Named::Backspace) => {
                return Some(Binding::Sequence(vec![Binding::Select(Motion::WordLeft), Binding::Backspace]));
            }
            Key::Named(Named::Delete) => {
                return Some(Binding::Sequence(vec![Binding::Select(Motion::WordRight), Binding::Delete]));
            }
            _ => {}
        }
    }
    Binding::from_key_press(k)
}

/// A text field over several lines, for prompts and instructions.
pub fn area<'a, M: Clone + 'a>(
    content: &'a text_editor::Content,
    placeholder: &'a str,
    on: impl Fn(text_editor::Action) -> M + 'a,
) -> text_editor::TextEditor<'a, iced::advanced::text::highlighter::PlainText, M> {
    text_editor(content)
        .placeholder(placeholder)
        .on_action(on)
        .key_binding(move |k| editor_keys(content, k))
        .size(FS_TEXT)
        .line_height(1.5)
        .padding([10, 14])
        .min_height(96)
        .max_height(320)
        .style(theme::editor)
}

/// The web's filled dropdown.
pub fn select<'a, T: ToString + PartialEq + Clone + 'a, M: Clone + 'a>(
    options: Vec<T>,
    selected: Option<T>,
    on: impl Fn(T) -> M + 'a,
) -> pick_list::PickList<'a, T, Vec<T>, T, M> {
    pick_list(options, selected, on)
        .style(theme::select)
        .text_size(FS_MD)
        .padding(Padding { top: 11.0, bottom: 11.0, left: SP_MD, right: SP_MD })
        .handle(pick_list::Handle::Arrow { size: Some(iced::Pixels(14.0)) })
}

/// A choice in a picker, shown by its name.
#[derive(Debug, Clone, PartialEq)]
pub struct Choice {
    pub id: String,
    pub name: String,
}

impl std::fmt::Display for Choice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.name)
    }
}

/// A setting picked from a list, its name beside it.
pub fn picker<'a, T: ToString + PartialEq + Clone + 'a, M: Clone + 'a>(
    name: &'a str,
    options: Vec<T>,
    selected: Option<T>,
    on: impl Fn(T) -> M + 'a,
) -> Element<'a, M> {
    row![text(name).size(theme::FS_LG).width(Length::Fill), select(options, selected, on)]
        .align_y(Alignment::Center)
        .spacing(SP_LG)
        .into()
}
