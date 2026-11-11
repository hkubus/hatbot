//! The mouse and keyboard, through CGEvent. Keys go by virtual key code, through the owner's layout
//! like a real keyboard's. Apps read a double click from the click count an event carries, and held
//! modifiers from its flags, so both are kept here.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use objc2_core_foundation::CGPoint;
use objc2_core_graphics::CGScrollEventUnit;
use objc2_core_graphics::{CGEvent, CGEventField, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton};

use super::screen;
use crate::computer::{Button, Result};
use crate::keycode::KeyCode;

/// Clicks this close together, in time and place, count as one double or triple click.
const MULTI_CLICK: Duration = Duration::from_millis(500);
const MULTI_CLICK_POINTS: f64 = 4.0;

#[derive(Default)]
struct State {
    flags: u64,
    held: [bool; 3],
    last_down: Option<(Button, Instant, CGPoint, i64)>,
}

static STATE: Mutex<State> = Mutex::new(State { flags: 0, held: [false; 3], last_down: None });

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

fn post(event: Option<objc2_core_foundation::CFRetained<CGEvent>>, flags: u64) -> Result<()> {
    let Some(event) = event else {
        return Err("macOS didn't take Hatbot's input.".into());
    };
    CGEvent::set_flags(Some(&event), CGEventFlags(flags));
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    Ok(())
}

fn index(b: Button) -> usize {
    match b {
        Button::Left => 0,
        Button::Right => 1,
        Button::Middle => 2,
    }
}

fn cg_button(b: Button) -> CGMouseButton {
    match b {
        Button::Left => CGMouseButton::Left,
        Button::Right => CGMouseButton::Right,
        Button::Middle => CGMouseButton::Center,
    }
}

/// To a point, in global points; a drag while a button is held.
pub fn move_to(p: CGPoint) -> Result<()> {
    let s = state();
    let (kind, button) = if s.held[0] {
        (CGEventType::LeftMouseDragged, CGMouseButton::Left)
    } else if s.held[1] {
        (CGEventType::RightMouseDragged, CGMouseButton::Right)
    } else if s.held[2] {
        (CGEventType::OtherMouseDragged, CGMouseButton::Center)
    } else {
        (CGEventType::MouseMoved, CGMouseButton::Left)
    };
    post(CGEvent::new_mouse_event(None, kind, p, button), s.flags)
}

pub fn button(b: Button, down: bool) -> Result<()> {
    let at = screen::pointer();
    let mut s = state();
    let clicks = if down {
        let now = Instant::now();
        let n = match s.last_down {
            Some((lb, t, lp, n))
                if lb == b
                    && now.duration_since(t) <= MULTI_CLICK
                    && (lp.x - at.x).abs() <= MULTI_CLICK_POINTS
                    && (lp.y - at.y).abs() <= MULTI_CLICK_POINTS =>
            {
                n + 1
            }
            _ => 1,
        };
        s.last_down = Some((b, now, at, n));
        n
    } else {
        s.last_down.filter(|(lb, ..)| *lb == b).map_or(1, |(.., n)| n)
    };
    let kind = match (b, down) {
        (Button::Left, true) => CGEventType::LeftMouseDown,
        (Button::Left, false) => CGEventType::LeftMouseUp,
        (Button::Right, true) => CGEventType::RightMouseDown,
        (Button::Right, false) => CGEventType::RightMouseUp,
        (Button::Middle, true) => CGEventType::OtherMouseDown,
        (Button::Middle, false) => CGEventType::OtherMouseUp,
    };
    s.held[index(b)] = down;
    let event = CGEvent::new_mouse_event(None, kind, at, cg_button(b));
    if let Some(e) = &event {
        CGEvent::set_integer_value_field(Some(e), CGEventField::MouseEventClickState, clicks);
    }
    post(event, s.flags)
}

/// Positive is down or right; macOS's wheels turn up and left for positive.
pub fn wheel(dx: i32, dy: i32) -> Result<()> {
    if dx == 0 && dy == 0 {
        return Ok(());
    }
    let flags = state().flags;
    post(CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Line, 2, -dy, -dx, 0), flags)
}

fn modifier(code: KeyCode) -> u64 {
    let f = match code.code() {
        42 | 54 => CGEventFlags::MaskShift,
        29 | 97 => CGEventFlags::MaskControl,
        56 | 100 => CGEventFlags::MaskAlternate,
        125 | 126 => CGEventFlags::MaskCommand,
        _ => return 0,
    };
    f.0
}

pub fn key(code: KeyCode, down: bool) -> Result<()> {
    let Some(vk) = code.mac() else {
        return Err("A Mac has no such key.".into());
    };
    let mut s = state();
    let m = modifier(code);
    if down {
        s.flags |= m;
    } else {
        s.flags &= !m;
    }
    post(CGEvent::new_keyboard_event(None, vk, down), s.flags)
}
