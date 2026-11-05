//! The mouse and keyboard, through SendInput. Keys go by scan code, through the owner's layout like a
//! real keyboard's.

use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC, MOUSE_EVENT_FLAGS, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MapVirtualKeyW,
    SendInput, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use crate::computer::{Button, Result};
use crate::keycode::{KeyCode, WinKey};

const WHEEL_CLICK: i32 = 120;

fn send(inputs: &[INPUT]) -> Result<()> {
    // SAFETY: a slice of plain structs and its element size.
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        // Windows drops input into a higher-privileged window, or while the session is locked.
        return Err("Windows didn't take Hatbot's input. An administrator's window may be in front.".into());
    }
    Ok(())
}

fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

/// To a point on the screen, in physical pixels.
pub fn move_to(x: i32, y: i32) -> Result<()> {
    // SAFETY: no pointers.
    let (vx, vy, vw, vh) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    // Absolute moves are in 0..=65535 across the whole desktop.
    let nx = ((x - vx) as i64 * 65535 / (vw - 1).max(1) as i64) as i32;
    let ny = ((y - vy) as i64 * 65535 / (vh - 1).max(1) as i64) as i32;
    send(&[mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0)])
}

pub fn button(button: Button, down: bool) -> Result<()> {
    let flags = match (button, down) {
        (Button::Left, true) => MOUSEEVENTF_LEFTDOWN,
        (Button::Left, false) => MOUSEEVENTF_LEFTUP,
        (Button::Right, true) => MOUSEEVENTF_RIGHTDOWN,
        (Button::Right, false) => MOUSEEVENTF_RIGHTUP,
        (Button::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
        (Button::Middle, false) => MOUSEEVENTF_MIDDLEUP,
    };
    send(&[mouse(flags, 0, 0, 0)])
}

/// Positive is down or right; Windows' wheel turns up for positive.
pub fn wheel(dx: i32, dy: i32) -> Result<()> {
    let mut inputs = Vec::new();
    if dy != 0 {
        inputs.push(mouse(MOUSEEVENTF_WHEEL, 0, 0, -dy * WHEEL_CLICK));
    }
    if dx != 0 {
        inputs.push(mouse(MOUSEEVENTF_HWHEEL, 0, 0, dx * WHEEL_CLICK));
    }
    if inputs.is_empty() { Ok(()) } else { send(&inputs) }
}

pub fn key(code: KeyCode, down: bool) -> Result<()> {
    let Some(k) = code.windows() else {
        return Err("Windows has no such key.".into());
    };
    let up = if down { KEYBD_EVENT_FLAGS(0) } else { KEYEVENTF_KEYUP };
    let ki = match k {
        WinKey::Scan { code, extended } => KEYBDINPUT {
            wVk: VIRTUAL_KEY(0),
            wScan: code,
            dwFlags: KEYEVENTF_SCANCODE | up | if extended { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) },
            time: 0,
            dwExtraInfo: 0,
        },
        WinKey::Virtual(vk) => KEYBDINPUT {
            wVk: VIRTUAL_KEY(vk),
            // SAFETY: no pointers.
            wScan: unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16,
            dwFlags: up,
            time: 0,
            dwExtraInfo: 0,
        },
    };
    send(&[INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki } }])
}
