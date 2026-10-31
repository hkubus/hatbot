// iced's button, which the keyboard can reach: Tab focuses it, Enter or Space presses it, and a ring shows it.
use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::operation::{Focusable, Operation};
use iced::advanced::widget::tree::{self, Tree};
use iced::advanced::{Clipboard, Shell, Widget, mouse, overlay, renderer};
use iced::border::Radius;
use iced::keyboard::{self, Key, key::Named};
pub use iced::widget::button::{Status, Style};
use iced::{Background, Border, Color, Element, Event, Length, Padding, Rectangle, Size, Theme, Vector, window};

use super::theme;

pub fn button<'a, M>(content: impl Into<Element<'a, M>>) -> Button<'a, M> {
    Button::new(content)
}

/// Wraps a control the keyboard can't otherwise reach, such as a checkbox or a dropdown, so Enter does `on`.
pub fn reach<'a, M: Clone + 'a>(content: impl Into<Element<'a, M>>, on: M, radius: f32) -> Button<'a, M> {
    button(content)
        .padding(0)
        .style(move |_, _| Style { border: iced::border::rounded(radius), ..Style::default() })
        .on_press(on)
}

type StyleFn<'a> = Box<dyn Fn(&Theme, Status) -> Style + 'a>;

pub struct Button<'a, M> {
    content: Element<'a, M>,
    on_press: Option<M>,
    on_step: Option<(M, M)>,
    width: Length,
    height: Length,
    padding: Padding,
    style: StyleFn<'a>,
    focusable: bool,
    status: Option<Status>,
}

impl<'a, M> Button<'a, M> {
    pub fn new(content: impl Into<Element<'a, M>>) -> Self {
        let content = content.into();
        let size = content.as_widget().size_hint();
        Button {
            content,
            on_press: None,
            on_step: None,
            width: size.width.fluid(),
            height: size.height.fluid(),
            padding: Padding { top: 5.0, bottom: 5.0, right: 10.0, left: 10.0 },
            style: Box::new(iced::widget::button::primary),
            focusable: true,
            status: None,
        }
    }

    pub fn width(mut self, width: impl Into<Length>) -> Self {
        self.width = width.into();
        self
    }

    pub fn height(mut self, height: impl Into<Length>) -> Self {
        self.height = height.into();
        self
    }

    pub fn padding(mut self, padding: impl Into<Padding>) -> Self {
        self.padding = padding.into();
        self
    }

    pub fn on_press(mut self, on: M) -> Self {
        self.on_press = Some(on);
        self
    }

    pub fn on_press_maybe(mut self, on: Option<M>) -> Self {
        self.on_press = on;
        self
    }

    /// What Up and Down send while it's focused, as a closed dropdown steps through its choices.
    pub fn on_step(mut self, up: M, down: M) -> Self {
        self.on_step = Some((up, down));
        self
    }

    pub fn style(mut self, style: impl Fn(&Theme, Status) -> Style + 'a) -> Self {
        self.style = Box::new(style);
        self
    }

    /// Left out of Tab's order, for a copy of a button that's reachable already.
    pub fn unfocusable(mut self) -> Self {
        self.focusable = false;
        self
    }
}

#[derive(Default)]
pub struct State {
    pressed: bool,
    focused: bool,
}

impl State {
    pub fn is_focused(&self) -> bool {
        self.focused
    }
}

impl Focusable for State {
    fn is_focused(&self) -> bool {
        self.focused
    }

    fn focus(&mut self) {
        self.focused = true;
    }

    fn unfocus(&mut self) {
        self.focused = false;
    }
}

impl<'a, M: Clone + 'a> Widget<M, Theme, iced::Renderer> for Button<'a, M> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn children(&self) -> Vec<Tree> {
        vec![Tree::new(&self.content)]
    }

    fn diff(&self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_ref(&self.content));
    }

    fn size(&self) -> Size<Length> {
        Size { width: self.width, height: self.height }
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &iced::Renderer, limits: &layout::Limits) -> layout::Node {
        layout::padded(limits, self.width, self.height, self.padding, |limits| {
            self.content.as_widget_mut().layout(&mut tree.children[0], renderer, limits)
        })
    }

    fn operate(
        &mut self,
        tree: &mut Tree,
        layout: Layout<'_>,
        renderer: &iced::Renderer,
        operation: &mut dyn Operation,
    ) {
        if self.focusable && self.on_press.is_some() {
            let state = tree.state.downcast_mut::<State>();
            operation.focusable(None, layout.bounds(), state);
            operation.custom(None, layout.bounds(), state);
        }
        operation.container(None, layout.bounds());
        operation.traverse(&mut |operation| {
            self.content.as_widget_mut().operate(
                &mut tree.children[0],
                layout.children().next().unwrap(),
                renderer,
                operation,
            );
        });
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        renderer: &iced::Renderer,
        clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, M>,
        viewport: &Rectangle,
    ) {
        self.content.as_widget_mut().update(
            &mut tree.children[0],
            event,
            layout.children().next().unwrap(),
            cursor,
            renderer,
            clipboard,
            shell,
            viewport,
        );
        let state = tree.state.downcast_mut::<State>();
        if self.on_press.is_none() {
            state.focused = false;
        }
        // A click anywhere takes the keyboard's focus away, as it does from a field.
        if let Event::Mouse(mouse::Event::ButtonPressed(_)) = event
            && state.focused
        {
            state.focused = false;
            shell.request_redraw();
        }
        if shell.is_event_captured() {
            return;
        }
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => {
                if self.on_press.is_some() && cursor.is_over(layout.bounds()) {
                    state.pressed = true;
                    shell.capture_event();
                }
            }
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) => {
                if let Some(on) = &self.on_press
                    && state.pressed
                {
                    state.pressed = false;
                    if cursor.is_over(layout.bounds()) {
                        shell.publish(on.clone());
                    }
                    shell.capture_event();
                }
            }
            Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, .. })
                if state.focused && !modifiers.command() && !modifiers.alt() =>
            {
                let sent = match key {
                    Key::Named(Named::Enter | Named::Space) => self.on_press.clone(),
                    Key::Named(Named::ArrowUp) => self.on_step.as_ref().map(|s| s.0.clone()),
                    Key::Named(Named::ArrowDown) => self.on_step.as_ref().map(|s| s.1.clone()),
                    _ => None,
                };
                if let Some(m) = sent {
                    shell.publish(m);
                    shell.capture_event();
                }
            }
            _ => {}
        }
        let status = if self.on_press.is_none() {
            Status::Disabled
        } else if cursor.is_over(layout.bounds()) {
            if state.pressed { Status::Pressed } else { Status::Hovered }
        } else if state.focused {
            Status::Hovered
        } else {
            Status::Active
        };
        if let Event::Window(window::Event::RedrawRequested(_)) = event {
            self.status = Some(status);
        } else if self.status.is_some_and(|s| s != status) {
            shell.request_redraw();
        }
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut iced::Renderer,
        theme: &Theme,
        _: &renderer::Style,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        use iced::advanced::Renderer as _;
        let bounds = layout.bounds();
        let style = (self.style)(theme, self.status.unwrap_or(Status::Disabled));
        if style.background.is_some() || style.border.width > 0.0 || style.shadow.color.a > 0.0 {
            renderer.fill_quad(
                renderer::Quad { bounds, border: style.border, shadow: style.shadow, snap: style.snap },
                style.background.unwrap_or(Background::Color(Color::TRANSPARENT)),
            );
        }
        self.content.as_widget().draw(
            &tree.children[0],
            renderer,
            theme,
            &renderer::Style { text_color: style.text_color },
            layout.children().next().unwrap(),
            cursor,
            viewport,
        );
        if tree.state.downcast_ref::<State>().focused {
            // The web's outline: 3px, 2px out.
            let r = style.border.radius;
            let out = |v: f32| v + 5.0;
            let radius = Radius {
                top_left: out(r.top_left),
                top_right: out(r.top_right),
                bottom_right: out(r.bottom_right),
                bottom_left: out(r.bottom_left),
            };
            let border = Border { color: theme::colors(theme).hue, width: 3.0, radius };
            renderer.fill_quad(
                renderer::Quad { bounds: bounds.expand(5.0), border, ..Default::default() },
                Color::TRANSPARENT,
            );
        }
    }

    fn mouse_interaction(
        &self,
        _: &Tree,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        _: &Rectangle,
        _: &iced::Renderer,
    ) -> mouse::Interaction {
        if cursor.is_over(layout.bounds()) && self.on_press.is_some() {
            mouse::Interaction::Pointer
        } else {
            mouse::Interaction::default()
        }
    }

    fn overlay<'b>(
        &'b mut self,
        tree: &'b mut Tree,
        layout: Layout<'b>,
        renderer: &iced::Renderer,
        viewport: &Rectangle,
        translation: Vector,
    ) -> Option<overlay::Element<'b, M, Theme, iced::Renderer>> {
        self.content.as_widget_mut().overlay(
            &mut tree.children[0],
            layout.children().next().unwrap(),
            renderer,
            viewport,
            translation,
        )
    }
}

impl<'a, M: Clone + 'a> From<Button<'a, M>> for Element<'a, M> {
    fn from(b: Button<'a, M>) -> Self {
        Element::new(b)
    }
}
