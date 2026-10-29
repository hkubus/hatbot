// The small pieces every page is built from, in the web's sizes.
use iced::widget::{Space, button, column, container, pick_list, row, scrollable, text, text_input, toggler, tooltip};
use iced::{Alignment, Color, Element, Length, Padding, Theme};

use super::icons::{self, Icon};
use super::theme::{self, Colors, FS_MD, FS_SM, FS_TEXT, FS_XL, H, H_SM, ICON, MEASURE, SP, SP_LG, SP_MD, SP_XL};

pub fn tone(f: fn(&Colors) -> Color) -> impl Fn(&Theme) -> text::Style {
    move |t| text::Style { color: Some(f(theme::colors(t))) }
}

pub fn body<'a>(s: impl text::IntoFragment<'a>) -> text::Text<'a> {
    text(s).size(FS_TEXT).line_height(1.5)
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
    let glyph = if lit { icons::filled(i, ICON, icons::on_hue) } else { icons::icon(i, ICON, icons::text_2) };
    let b = button(container(glyph).center(Length::Fill))
        .width(H)
        .height(H)
        .padding(0)
        .style(if lit { theme::toggle(true) } else { theme::toggle(false) })
        .on_press_maybe(on);
    tooltip(b, container(text(name).size(FS_SM)).padding([4, 8]).style(theme::toast), tooltip::Position::Bottom).into()
}

pub fn input<'a, M: Clone + 'a>(
    placeholder: &str,
    value: &str,
    on: impl Fn(String) -> M + 'a,
) -> text_input::TextInput<'a, M> {
    text_input(placeholder, value).on_input(on).padding([10, 14]).size(FS_TEXT).style(theme::input)
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
    let words = column![text(name).size(FS_TEXT)].push(about.map(small)).spacing(2).width(Length::Fill);
    let mut t = toggler(on).size(24).style(theme::switch);
    if let Some(change) = change {
        t = t.on_toggle(change);
    }
    row![words, t].spacing(SP_LG).align_y(Alignment::Center).into()
}

pub fn card<'a, M: 'a>(content: impl Into<Element<'a, M>>) -> container::Container<'a, M> {
    container(content).padding(SP_LG).width(Length::Fill).style(theme::card)
}

/// A page's body: centred at the reading width, scrolling.
pub fn page<'a, M: 'a>(content: impl Into<Element<'a, M>>) -> Element<'a, M> {
    scrollable(
        container(container(content).max_width(MEASURE).width(Length::Fill))
            .center_x(Length::Fill)
            .padding([SP_LG, SP_XL]),
    )
    .style(theme::scroll)
    .height(Length::Fill)
    .into()
}

/// What shows where there's nothing yet.
pub fn empty<'a, M: 'a>(s: impl text::IntoFragment<'a>) -> Element<'a, M> {
    container(text(s).size(FS_TEXT).style(tone(|c| c.muted)).align_x(Alignment::Center))
        .center_x(Length::Fill)
        .padding([SP_XL * 2.0, SP_XL])
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
    container(text(n.to_string()).size(FS_SM).font(theme::SEMIBOLD)).padding([1, 7]).style(theme::badge).into()
}

/// A choice between a few views, as the web's segmented chips.
pub fn segmented<'a, M: Clone + 'a, V: Copy + PartialEq + 'a>(
    options: &[(&'a str, V)],
    selected: V,
    on: impl Fn(V) -> M,
) -> Element<'a, M> {
    let mut r = row![].spacing(SP);
    for (name, v) in options {
        r = r.push(
            button(container(label(*name)).center_y(Length::Fill))
                .height(H_SM)
                .padding([0.0, SP_MD])
                .style(theme::chip(*v == selected))
                .on_press(on(*v)),
        );
    }
    r.into()
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

/// A text field over several lines, for prompts and instructions.
pub fn area<'a, M: Clone + 'a>(
    content: &'a iced::widget::text_editor::Content,
    placeholder: &'a str,
    on: impl Fn(iced::widget::text_editor::Action) -> M + 'a,
) -> iced::widget::TextEditor<'a, iced::advanced::text::highlighter::PlainText, M> {
    iced::widget::text_editor(content)
        .placeholder(placeholder)
        .on_action(on)
        .size(FS_TEXT)
        .line_height(1.5)
        .padding([10, 14])
        .min_height(96)
        .max_height(320)
        .style(theme::editor)
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
    row![
        text(name).size(theme::FS_TEXT).width(Length::Fill),
        pick_list(options, selected, on).style(theme::select).padding([8, 14])
    ]
    .align_y(Alignment::Center)
    .spacing(SP_LG)
    .into()
}
