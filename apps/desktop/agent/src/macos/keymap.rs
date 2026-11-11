//! What each key types on the owner's keyboard layouts, asked of macOS key by key. Text Input Sources
//! want the main thread.

use std::collections::HashMap;
use std::ffi::c_void;

use objc2_core_foundation::{CFArray, CFData, CFRetained, CFString, CFType};

use crate::computer::Result;
use crate::keycode::KeyCode;
use crate::typing::{self, KeyTable, Stroke};

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    static kTISPropertyUnicodeKeyLayoutData: &'static CFString;
    static kTISPropertyInputSourceID: &'static CFString;
    static kTISPropertyInputSourceType: &'static CFString;
    static kTISTypeKeyboardLayout: &'static CFString;
    fn TISCopyCurrentKeyboardLayoutInputSource() -> *mut CFType;
    fn TISCreateInputSourceList(properties: *const c_void, include_all_installed: u8) -> *mut CFArray;
    fn TISGetInputSourceProperty(source: &CFType, key: &CFString) -> *const CFType;
    fn LMGetKbdType() -> u8;
    fn UCKeyTranslate(
        layout: *const u8,
        virtual_key: u16,
        action: u16,
        modifier_state: u32,
        keyboard_type: u32,
        options: u32,
        dead_key_state: *mut u32,
        max_len: usize,
        actual_len: *mut usize,
        chars: *mut u16,
    ) -> i32;
}

const KEY_DOWN: u16 = 0;
const NO_DEAD_KEYS: u32 = 1;
/// Carbon's shiftKey and optionKey, shifted down a byte as UCKeyTranslate takes them.
const SHIFT: u32 = 0x02;
const OPTION: u32 = 0x08;

fn property<'a>(source: &'a CFType, key: &CFString) -> Option<&'a CFType> {
    // SAFETY: a property of a live input source, not retained (the Get rule): it lives as long as the
    // source does.
    unsafe { TISGetInputSourceProperty(source, key).as_ref() }
}

fn id(source: &CFType) -> Option<String> {
    // SAFETY: as above.
    property(source, unsafe { kTISPropertyInputSourceID })?.downcast_ref::<CFString>().map(|s| s.to_string())
}

fn layout(source: &CFType) -> Option<HashMap<char, Stroke>> {
    // SAFETY: as above.
    let data = property(source, unsafe { kTISPropertyUnicodeKeyLayoutData })?.downcast_ref::<CFData>()?;
    let ptr = data.byte_ptr();
    // SAFETY: no pointers.
    let kbd = unsafe { LMGetKbdType() } as u32;
    let mut table = HashMap::new();
    for code in (1u16..=83).chain([86]) {
        let Some(vk) = KeyCode::new(code).mac() else { continue };
        for (shift, option) in [(false, false), (true, false), (false, true), (true, true)] {
            let mods = if shift { SHIFT } else { 0 } | if option { OPTION } else { 0 };
            let (mut dead, mut len, mut out) = (0u32, 0usize, [0u16; 4]);
            // SAFETY: the layout data is the system's own UCKeyboardLayout, and the output buffer's
            // length goes with it.
            let err = unsafe {
                UCKeyTranslate(
                    ptr,
                    vk,
                    KEY_DOWN,
                    mods,
                    kbd,
                    NO_DEAD_KEYS,
                    &mut dead,
                    out.len(),
                    &mut len,
                    out.as_mut_ptr(),
                )
            };
            // Dead keys type nothing, and ligatures more than one character, in one press.
            if err != 0 || len != 1 {
                continue;
            }
            let Some(c) = char::from_u32(out[0] as u32).filter(|c| !c.is_control()) else { continue };
            typing::add(&mut table, c, Stroke { code: KeyCode::new(code), shift, altgr: option });
        }
    }
    Some(table)
}

pub fn table() -> Result<KeyTable> {
    // SAFETY: both come back retained, and are taken as such.
    let (current, list) = unsafe {
        let current = TISCopyCurrentKeyboardLayoutInputSource();
        let list = TISCreateInputSourceList(std::ptr::null(), 0);
        (
            std::ptr::NonNull::new(current).map(|p| CFRetained::from_raw(p)),
            std::ptr::NonNull::new(list).map(|p| CFRetained::from_raw(p)),
        )
    };
    let current = current.ok_or("macOS didn't say which keyboard layout is in use.")?;
    // SAFETY: the list holds input sources.
    let enabled: Vec<CFRetained<CFType>> =
        list.map(|l| unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(l) }.to_vec()).unwrap_or_default();
    let keyboard = |s: &CFType| {
        // SAFETY: as in `property`.
        let kind = property(s, unsafe { kTISPropertyInputSourceType }).and_then(|t| t.downcast_ref::<CFString>());
        kind.is_some_and(|k| k == unsafe { kTISTypeKeyboardLayout })
    };
    let mut sources: Vec<&CFType> = enabled.iter().map(|s| &**s).filter(|s| keyboard(s)).collect();
    let now = id(&current);
    let at = match sources.iter().position(|s| id(s) == now) {
        Some(i) => i,
        None => {
            sources.push(&current);
            sources.len() - 1
        }
    };
    let mut layouts = Vec::new();
    let mut current_index = 0;
    for (i, s) in sources.into_iter().enumerate() {
        if let Some(l) = layout(s) {
            if i == at {
                current_index = layouts.len();
            }
            layouts.push(l);
        }
    }
    if layouts.is_empty() {
        return Err("macOS didn't give Hatbot the keyboard layout.".into());
    }
    Ok(KeyTable::new(layouts, current_index))
}
