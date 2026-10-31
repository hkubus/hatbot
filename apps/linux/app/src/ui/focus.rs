// Moving the keyboard's focus: Tab and Shift+Tab through everything, the arrows between buttons, F6 between the
// window's parts, and whatever gets focused scrolled into view.
use std::any::Any;

use iced::advanced::widget::operation::{self, Focusable, Operation, Outcome, Scrollable};
use iced::advanced::widget::{Id, operate};
use iced::widget::operation::AbsoluteOffset;
use iced::{Rectangle, Task, Vector};

use super::button;

/// The window's parts, in F6's order.
pub const NAV: &str = "focus-nav";
pub const BAR: &str = "focus-bar";
pub const MAIN: &str = "focus-main";
pub const COMPOSER: &str = "focus-composer";
const REGIONS: [&str; 4] = [NAV, BAR, MAIN, COMPOSER];

/// What's over the window, a dialog or a menu: while it's there, the focus stays in it.
pub const MODAL: &str = "focus-modal";

/// Scrollables that keep to their bottom, as the chat does, scroll the other way.
pub const BOTTOM: &str = "focus-bottom";

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum Move {
    #[default]
    Next,
    Previous,
    /// The arrows: only from a focused button, so they don't leave a field or move a page that has nothing focused.
    Down,
    Up,
    Region(bool),
    /// Into a dialog that just opened, if the keyboard had the focus somewhere.
    Enter,
    /// Back to where it was, by its place in the window.
    To(usize),
}

pub fn shift<T: Send + 'static>(m: Move) -> Task<T> {
    moved(m).discard()
}

/// Moves the focus, and gives where it was.
pub fn moved(m: Move) -> Task<Option<usize>> {
    operate(operation(m))
}

fn operation(m: Move) -> impl Operation<Option<usize>> {
    operation::then(Collect { mv: m, ..Collect::default() }, |plan: Plan| Apply { plan, at: 0, scroll: 0 })
}

struct Item {
    bounds: Rectangle,
    region: Option<usize>,
    modal: bool,
    /// The scrollables it's in, outermost first.
    scrolls: Vec<usize>,
}

struct Scroll {
    bounds: Rectangle,
    content: Rectangle,
    translation: Vector,
    bottom: bool,
}

#[derive(Default)]
struct Collect {
    mv: Move,
    items: Vec<Item>,
    focused: Option<usize>,
    on_button: bool,
    scrolls: Vec<Scroll>,
    /// What the widget about to traverse its children is.
    entering: Option<Inside>,
    region: Vec<usize>,
    modal: usize,
    has_modal: bool,
    inside: Vec<usize>,
    bottom_next: bool,
}

#[derive(Clone, Copy)]
enum Inside {
    Region(usize),
    Modal,
    Scroll(usize),
}

#[derive(Clone, Default)]
struct Plan {
    from: Option<usize>,
    target: Option<usize>,
    scrolls: Vec<(usize, f32)>,
}

impl Operation<Plan> for Collect {
    fn traverse(&mut self, operate: &mut dyn FnMut(&mut dyn Operation<Plan>)) {
        let entering = self.entering.take();
        match entering {
            Some(Inside::Region(r)) => self.region.push(r),
            Some(Inside::Modal) => {
                self.modal += 1;
                self.has_modal = true;
            }
            Some(Inside::Scroll(i)) => self.inside.push(i),
            None => {}
        }
        operate(self);
        match entering {
            Some(Inside::Region(_)) => _ = self.region.pop(),
            Some(Inside::Modal) => self.modal -= 1,
            Some(Inside::Scroll(_)) => _ = self.inside.pop(),
            None => {}
        }
    }

    fn container(&mut self, id: Option<&Id>, _: Rectangle) {
        let is = |name: &'static str| id.is_some_and(|id| *id == Id::new(name));
        self.entering = REGIONS.iter().position(|r| is(r)).map(Inside::Region).or(is(MODAL).then_some(Inside::Modal));
        if is(BOTTOM) {
            self.bottom_next = true;
        }
    }

    fn scrollable(
        &mut self,
        _: Option<&Id>,
        bounds: Rectangle,
        content: Rectangle,
        translation: Vector,
        _: &mut dyn Scrollable,
    ) {
        let bottom = std::mem::take(&mut self.bottom_next);
        self.entering = Some(Inside::Scroll(self.scrolls.len()));
        self.scrolls.push(Scroll { bounds, content, translation, bottom });
    }

    fn focusable(&mut self, _: Option<&Id>, bounds: Rectangle, state: &mut dyn Focusable) {
        self.entering = None;
        if state.is_focused() {
            self.focused = Some(self.items.len());
            self.on_button = false;
        }
        self.items.push(Item {
            bounds,
            region: self.region.last().copied(),
            modal: self.modal > 0,
            scrolls: self.inside.clone(),
        });
    }

    fn custom(&mut self, _: Option<&Id>, _: Rectangle, state: &mut dyn Any) {
        if let Some(b) = state.downcast_ref::<button::State>()
            && b.is_focused()
        {
            self.on_button = true;
        }
    }

    fn finish(&self) -> Outcome<Plan> {
        Outcome::Some(self.plan())
    }
}

impl Collect {
    fn plan(&self) -> Plan {
        let reach: Vec<usize> = (0..self.items.len()).filter(|&i| !self.has_modal || self.items[i].modal).collect();
        let n = reach.len();
        let from = self.focused;
        if n == 0 {
            return Plan { from, ..Plan::default() };
        }
        let at = self.focused.and_then(|f| reach.iter().position(|&i| i == f));
        let pick = match self.mv {
            Move::Next => Some(at.map_or(0, |i| (i + 1) % n)),
            Move::Previous => Some(at.map_or(n - 1, |i| (i + n - 1) % n)),
            Move::Down if self.on_button => at.map(|i| (i + 1).min(n - 1)),
            Move::Up if self.on_button => at.map(|i| i.saturating_sub(1)),
            Move::Down | Move::Up => None,
            Move::Region(forward) => self.region_start(&reach, at, forward),
            Move::Enter => from.map(|_| 0),
            Move::To(i) => reach.iter().position(|&r| r == i),
        };
        let Some(pick) = pick else { return Plan { from, ..Plan::default() } };
        let target = reach[pick];
        Plan { from, target: Some(target), scrolls: self.to_show(&self.items[target]) }
    }

    /// The first of the next part of the window that has anything to focus.
    fn region_start(&self, reach: &[usize], at: Option<usize>, forward: bool) -> Option<usize> {
        let of = |i: usize| self.items[reach[i]].region;
        // Outside every part counts as a part after the last.
        let count = REGIONS.len() + 1;
        let index = |i: usize| of(i).unwrap_or(REGIONS.len());
        let start = at.map_or(if forward { count - 1 } else { 0 }, index);
        (1..=count).find_map(|step| {
            let r = if forward { (start + step) % count } else { (start + count - step) % count };
            (0..reach.len()).find(|&i| index(i) == r)
        })
    }

    /// How far each scrollable around the target scrolls to show it, innermost first.
    fn to_show(&self, item: &Item) -> Vec<(usize, f32)> {
        const MARGIN: f32 = 24.0;
        let target = item.bounds;
        let mut shown = 0.0;
        let mut out = vec![];
        for &i in item.scrolls.iter().rev() {
            let s = &self.scrolls[i];
            let c = s.content;
            if c.height <= s.bounds.height {
                continue;
            }
            let top = target.y - shown - s.bounds.y - MARGIN;
            let bottom = target.y - shown + target.height - s.bounds.y - s.bounds.height + MARGIN;
            let now = s.translation.y;
            let want = if top < now || target.height + 2.0 * MARGIN > s.bounds.height {
                top
            } else if bottom > now {
                bottom
            } else {
                now
            };
            let want = want.clamp(0.0, c.height - s.bounds.height);
            if want != now {
                out.push((i, if s.bottom { now - want } else { want - now }));
            }
            shown += want;
        }
        out
    }
}

struct Apply {
    plan: Plan,
    at: usize,
    scroll: usize,
}

impl Operation<Option<usize>> for Apply {
    fn traverse(&mut self, operate: &mut dyn FnMut(&mut dyn Operation<Option<usize>>)) {
        operate(self);
    }

    fn finish(&self) -> Outcome<Option<usize>> {
        Outcome::Some(self.plan.from)
    }

    fn scrollable(
        &mut self,
        _: Option<&Id>,
        bounds: Rectangle,
        content: Rectangle,
        _: Vector,
        state: &mut dyn Scrollable,
    ) {
        if let Some((_, dy)) = self.plan.scrolls.iter().find(|(i, _)| *i == self.scroll) {
            state.scroll_by(AbsoluteOffset { x: 0.0, y: *dy }, bounds, content);
        }
        self.scroll += 1;
    }

    fn focusable(&mut self, _: Option<&Id>, _: Rectangle, state: &mut dyn Focusable) {
        if let Some(target) = self.plan.target {
            if self.at == target {
                state.focus();
            } else {
                state.unfocus();
            }
        }
        self.at += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iced::widget::operation::RelativeOffset;
    use iced::{Point, Size};

    enum Node {
        Field(f32),
        Button(f32),
        In(&'static str, Vec<Node>),
        Scrolls { y: f32, height: f32, content: f32, at: f32, kids: Vec<Node> },
    }
    use Node::*;

    #[derive(Default)]
    struct World {
        focus: Vec<button::State>,
        scrolled: Vec<f32>,
        next: usize,
        next_scroll: usize,
    }

    struct Scrolled<'a>(&'a mut f32);

    impl Scrollable for Scrolled<'_> {
        fn snap_to(&mut self, _: RelativeOffset<Option<f32>>) {}
        fn scroll_to(&mut self, _: AbsoluteOffset<Option<f32>>) {}
        fn scroll_by(&mut self, by: AbsoluteOffset, _: Rectangle, _: Rectangle) {
            *self.0 += by.y;
        }
    }

    fn rect(y: f32, height: f32) -> Rectangle {
        Rectangle::new(Point::new(0.0, y), Size::new(100.0, height))
    }

    fn walk(op: &mut dyn Operation<Option<usize>>, nodes: &[Node], w: &mut World) {
        for n in nodes {
            match n {
                Field(y) | Button(y) => {
                    let i = w.next;
                    w.next += 1;
                    if w.focus.len() <= i {
                        w.focus.push(button::State::default());
                    }
                    op.focusable(None, rect(*y, 20.0), &mut w.focus[i]);
                    if matches!(n, Button(_)) {
                        op.custom(None, rect(*y, 20.0), &mut w.focus[i]);
                    }
                }
                In(name, kids) => {
                    op.container(Some(&Id::new(name)), rect(0.0, 0.0));
                    op.traverse(&mut |op| walk(op, kids, w));
                }
                Scrolls { y, height, content, at, kids } => {
                    let i = w.next_scroll;
                    w.next_scroll += 1;
                    if w.scrolled.len() <= i {
                        w.scrolled.push(0.0);
                    }
                    let mut s = Scrolled(&mut w.scrolled[i]);
                    op.scrollable(None, rect(*y, *height), rect(*y, *content), Vector::new(0.0, *at), &mut s);
                    op.traverse(&mut |op| walk(op, kids, w));
                }
            }
        }
    }

    /// Runs a move over the tree as iced would, and gives where the focus was and where it is.
    fn run(m: Move, tree: &[Node], w: &mut World) -> (Option<usize>, Option<usize>) {
        let mut op: Box<dyn Operation<Option<usize>>> = Box::new(operation(m));
        let from = loop {
            w.next = 0;
            w.next_scroll = 0;
            walk(op.as_mut(), tree, w);
            match op.finish() {
                Outcome::Chain(next) => op = next,
                Outcome::Some(from) => break from,
                Outcome::None => break None,
            }
        };
        (from, w.focus.iter().position(|f| f.is_focused()))
    }

    #[test]
    fn tab_goes_through_everything_and_round_again() {
        let tree = [Button(0.0), Field(30.0), Button(60.0)];
        let mut w = World::default();
        assert_eq!(run(Move::Next, &tree, &mut w).1, Some(0));
        assert_eq!(run(Move::Next, &tree, &mut w).1, Some(1));
        run(Move::Next, &tree, &mut w);
        assert_eq!(run(Move::Next, &tree, &mut w).1, Some(0));
        assert_eq!(run(Move::Previous, &tree, &mut w).1, Some(2));
    }

    #[test]
    fn shift_tab_with_nothing_focused_starts_at_the_end() {
        let mut w = World::default();
        assert_eq!(run(Move::Previous, &[Button(0.0), Button(30.0)], &mut w).1, Some(1));
    }

    #[test]
    fn a_dialog_keeps_the_focus_in_it() {
        let tree = [Button(0.0), In(MODAL, vec![Button(30.0), Button(60.0)])];
        let mut w = World::default();
        assert_eq!(run(Move::Next, &tree, &mut w).1, Some(1));
        run(Move::Next, &tree, &mut w);
        assert_eq!(run(Move::Next, &tree, &mut w).1, Some(1));
        assert_eq!(run(Move::Previous, &tree, &mut w).1, Some(2));
    }

    #[test]
    fn f6_goes_to_the_next_part_that_has_something() {
        let tree = [
            In(NAV, vec![Button(0.0), Button(30.0)]),
            In(BAR, vec![]),
            In(MAIN, vec![Button(60.0), In(COMPOSER, vec![Field(90.0)])]),
        ];
        let mut w = World::default();
        assert_eq!(run(Move::Region(true), &tree, &mut w).1, Some(0));
        assert_eq!(run(Move::Region(true), &tree, &mut w).1, Some(2));
        assert_eq!(run(Move::Region(true), &tree, &mut w).1, Some(3));
        assert_eq!(run(Move::Region(true), &tree, &mut w).1, Some(0));
        assert_eq!(run(Move::Region(false), &tree, &mut w).1, Some(3));
    }

    #[test]
    fn arrows_move_only_from_a_button() {
        let tree = [Field(0.0), Button(30.0), Button(60.0)];
        let mut w = World::default();
        assert_eq!(run(Move::Down, &tree, &mut w).1, None);
        run(Move::Next, &tree, &mut w);
        assert_eq!(run(Move::Down, &tree, &mut w).1, Some(0));
        run(Move::Next, &tree, &mut w);
        assert_eq!(run(Move::Down, &tree, &mut w).1, Some(2));
        assert_eq!(run(Move::Down, &tree, &mut w).1, Some(2));
        assert_eq!(run(Move::Up, &tree, &mut w).1, Some(1));
    }

    #[test]
    fn what_gets_the_focus_is_scrolled_into_view() {
        let page = |kids| Scrolls { y: 0.0, height: 100.0, content: 400.0, at: 0.0, kids };
        let mut w = World::default();
        run(Move::Next, &[page(vec![Button(300.0)])], &mut w);
        assert_eq!(w.scrolled, [244.0]);
        // The chat keeps to its bottom, so its offset runs the other way.
        let mut w = World::default();
        run(Move::Next, &[In(BOTTOM, vec![page(vec![Button(300.0)])])], &mut w);
        assert_eq!(w.scrolled, [-244.0]);
    }

    #[test]
    fn a_dialog_over_a_page_doesnt_scroll_it() {
        let tree = [
            Scrolls { y: 0.0, height: 100.0, content: 400.0, at: 300.0, kids: vec![Button(320.0)] },
            In(MODAL, vec![Button(50.0)]),
        ];
        let mut w = World::default();
        run(Move::Next, &tree, &mut w);
        assert_eq!(w.scrolled, [0.0]);
    }

    #[test]
    fn the_focus_goes_into_a_dialog_and_back_where_it_was() {
        let page = [Button(0.0), Button(30.0)];
        let mut w = World::default();
        assert_eq!(run(Move::Enter, &page, &mut w), (None, None));
        run(Move::Next, &page, &mut w);
        run(Move::Next, &page, &mut w);
        let open = [Button(0.0), Button(30.0), In(MODAL, vec![Button(50.0)])];
        assert_eq!(run(Move::Enter, &open, &mut w), (Some(1), Some(2)));
        w.focus.truncate(2);
        assert_eq!(run(Move::To(1), &page, &mut w).1, Some(1));
    }
}
