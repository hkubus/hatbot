//! What each key types on the owner's keyboard layouts, asked of Windows key by key.

use std::collections::HashMap;

use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyboardLayout, GetKeyboardLayoutList, HKL, MAPVK_VSC_TO_VK_EX, MapVirtualKeyExW, ToUnicodeEx, VK_CONTROL,
    VK_MENU, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

use crate::computer::Result;
use crate::keycode::KeyCode;
use crate::typing::{self, KeyTable, Stroke};

/// Leaves the keyboard's dead-key state alone while asking (Windows 10 1607 and later).
const DONT_CHANGE_STATE: u32 = 0x4;

fn layout(hkl: HKL) -> HashMap<char, Stroke> {
    let mut table = HashMap::new();
    // Set-1 scan codes of the main keys and the keypad, which are evdev's numbers.
    for scan in (1u16..=83).chain([86]) {
        // SAFETY: no pointers.
        let vk = unsafe { MapVirtualKeyExW(scan as u32, MAPVK_VSC_TO_VK_EX, Some(hkl)) };
        if vk == 0 {
            continue;
        }
        for (shift, altgr) in [(false, false), (true, false), (false, true), (true, true)] {
            let mut state = [0u8; 256];
            if shift {
                state[VK_SHIFT.0 as usize] = 0x80;
            }
            if altgr {
                // AltGr is Ctrl+Alt to Windows.
                state[VK_CONTROL.0 as usize] = 0x80;
                state[VK_MENU.0 as usize] = 0x80;
            }
            let mut out = [0u16; 8];
            // SAFETY: the state and output buffers are the sizes Windows expects.
            let n = unsafe { ToUnicodeEx(vk, scan as u32, &state, &mut out, DONT_CHANGE_STATE, Some(hkl)) };
            // Dead keys (negative) and ligatures (more than one) can't be typed in one press.
            if n != 1 {
                continue;
            }
            let Some(c) = char::from_u32(out[0] as u32).filter(|c| !c.is_control()) else { continue };
            typing::add(&mut table, c, Stroke { code: KeyCode::new(scan), shift, altgr });
        }
    }
    table
}

pub fn table() -> Result<KeyTable> {
    // SAFETY: a first call for the count, then a buffer of that size.
    let layouts: Vec<HKL> = unsafe {
        let n = GetKeyboardLayoutList(None);
        let mut buf = vec![HKL::default(); n.max(0) as usize];
        let got = GetKeyboardLayoutList(Some(&mut buf));
        buf.truncate(got.max(0) as usize);
        buf
    };
    // Each thread has its own layout: the one in front is what typing lands in.
    // SAFETY: no pointers.
    let now = unsafe { GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), None)) };
    let layouts = if layouts.is_empty() { vec![now] } else { layouts };
    let current = layouts.iter().position(|h| *h == now).unwrap_or(0);
    Ok(KeyTable::new(layouts.into_iter().map(layout).collect(), current))
}
