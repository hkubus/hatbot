//! Key names from the model ("ctrl+shift+Escape", "Page_Down", "enter") as `packages/shared/src/keys.ts`
//! reads them, to evdev key codes. Only names on its lists are pressed, so the brain's checks see
//! every key that goes out.

use evdev::KeyCode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modifier {
    Ctrl,
    Shift,
    Alt,
    Super,
}

impl Modifier {
    pub fn code(self) -> KeyCode {
        match self {
            Modifier::Ctrl => KeyCode::KEY_LEFTCTRL,
            Modifier::Shift => KeyCode::KEY_LEFTSHIFT,
            Modifier::Alt => KeyCode::KEY_LEFTALT,
            Modifier::Super => KeyCode::KEY_LEFTMETA,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    Mod(Modifier),
    /// A named key, by evdev code.
    Named(KeyCode),
    /// A character, pressed through the current layout.
    Char(char),
}

/// One combination: the modifiers held, then the key pressed (none for modifiers alone).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub mods: Vec<Modifier>,
    pub key: Option<Key>,
}

fn modifier(lower: &str) -> Option<Modifier> {
    Some(match lower {
        "ctrl" | "control" | "control_l" | "control_r" => Modifier::Ctrl,
        "shift" | "shift_l" | "shift_r" => Modifier::Shift,
        "alt" | "option" | "alt_l" | "alt_r" => Modifier::Alt,
        "super" | "meta" | "cmd" | "command" | "win" | "windows" | "super_l" | "super_r"
        | "meta_l" | "meta_r" => Modifier::Super,
        _ => return None,
    })
}

fn named(lower: &str) -> Option<KeyCode> {
    Some(match lower {
        "return" | "enter" => KeyCode::KEY_ENTER,
        // The brain reads KP_Enter as Enter; it's pressed as itself.
        "kp_enter" => KeyCode::KEY_KPENTER,
        "space" => KeyCode::KEY_SPACE,
        "tab" => KeyCode::KEY_TAB,
        "escape" | "esc" => KeyCode::KEY_ESC,
        "backspace" => KeyCode::KEY_BACKSPACE,
        "delete" | "del" => KeyCode::KEY_DELETE,
        "insert" => KeyCode::KEY_INSERT,
        "up" | "arrowup" => KeyCode::KEY_UP,
        "down" | "arrowdown" => KeyCode::KEY_DOWN,
        "left" | "arrowleft" => KeyCode::KEY_LEFT,
        "right" | "arrowright" => KeyCode::KEY_RIGHT,
        "home" => KeyCode::KEY_HOME,
        "end" => KeyCode::KEY_END,
        "page_up" | "pageup" | "pgup" | "prior" => KeyCode::KEY_PAGEUP,
        "page_down" | "pagedown" | "pgdn" | "next" => KeyCode::KEY_PAGEDOWN,
        // X's Menu and Print keysyms sit on these keys.
        "menu" | "contextmenu" => KeyCode::KEY_COMPOSE,
        "print" | "printscreen" => KeyCode::KEY_SYSRQ,
        "capslock" | "caps_lock" => KeyCode::KEY_CAPSLOCK,
        _ => return function_key(lower),
    })
}

fn function_key(lower: &str) -> Option<KeyCode> {
    let n: u16 = lower.strip_prefix('f')?.parse().ok()?;
    if lower.len() > 3 || lower.starts_with("f0") {
        return None;
    }
    match n {
        1..=10 => Some(KeyCode::new(KeyCode::KEY_F1.code() + n - 1)),
        11 => Some(KeyCode::KEY_F11),
        12 => Some(KeyCode::KEY_F12),
        13..=24 => Some(KeyCode::new(KeyCode::KEY_F13.code() + n - 13)),
        _ => None,
    }
}

/// One printable character: a letter, digit, punctuation or symbol, not a control, space or mark.
pub fn printable(c: char) -> bool {
    !c.is_control()
        && !c.is_whitespace()
        && !matches!(c, '\u{0300}'..='\u{036f}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')
}

pub fn read_key(name: &str) -> Option<Key> {
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return printable(c).then_some(Key::Char(c));
    }
    let lower = name.to_lowercase();
    modifier(&lower).map(Key::Mod).or_else(|| named(&lower).map(Key::Named))
}

/// "ctrl+shift+t" in parts; a lone "+", or one at the end ("ctrl++"), is the plus key.
fn combo_parts(text: &str) -> Vec<&str> {
    let t = text.trim();
    if t == "+" {
        return vec!["+"];
    }
    match t.strip_suffix("++") {
        Some(rest) => rest.split('+').chain(["+"]).collect(),
        None => t.split('+').collect(),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct KeyError(pub String);

/// Reads one combination: modifiers first, then at most one key, last.
pub fn read_combo(text: &str) -> Result<Combo, KeyError> {
    if text.trim().is_empty() {
        return Err(KeyError("Empty key name.".into()));
    }
    let mut mods = Vec::new();
    let mut key = None;
    for part in combo_parts(text) {
        if part.is_empty() {
            return Err(KeyError(format!("Can't read the key combination \"{text}\".")));
        }
        let Some(k) = read_key(part) else {
            return Err(KeyError(format!(
                "Unknown key \"{part}\". Use a key's name (Return, Tab, Page_Down, F5) or a character."
            )));
        };
        if key.is_some() {
            return Err(KeyError(format!(
                "\"{text}\": put the modifiers first and one key last, like ctrl+shift+t."
            )));
        }
        match k {
            Key::Mod(m) => mods.push(m),
            other => key = Some(other),
        }
    }
    Ok(Combo { mods, key })
}

/// A key action's text as combinations, one per space-separated name ("ctrl+a Delete").
pub fn read_combos(text: &str) -> Result<Vec<Combo>, KeyError> {
    let combos: Vec<_> = text.split_whitespace().map(read_combo).collect::<Result<_, _>>()?;
    if combos.is_empty() {
        return Err(KeyError("Empty key name.".into()));
    }
    Ok(combos)
}

/// Modifiers held during a click or scroll ("ctrl+shift"); each must be a modifier.
pub fn read_modifiers(text: Option<&str>) -> Result<Vec<Modifier>, KeyError> {
    let Some(text) = text.filter(|t| !t.trim().is_empty()) else {
        return Ok(vec![]);
    };
    text.split('+')
        .map(|p| {
            modifier(&p.trim().to_lowercase()).ok_or_else(|| {
                KeyError(format!("\"{p}\" is not a modifier key (ctrl, shift, alt, super)."))
            })
        })
        .collect()
}

/// A browser `KeyboardEvent.key` from Live, or None for a printable character (typed instead). It's
/// the owner's own keyboard, so keys off the model's lists are pressed too.
pub fn browser_key(key: &str) -> Option<KeyCode> {
    Some(match key {
        "Shift" => KeyCode::KEY_LEFTSHIFT,
        "Control" => KeyCode::KEY_LEFTCTRL,
        "Alt" => KeyCode::KEY_LEFTALT,
        "Meta" => KeyCode::KEY_LEFTMETA,
        "AltGraph" => KeyCode::KEY_RIGHTALT,
        "ScrollLock" => KeyCode::KEY_SCROLLLOCK,
        "Pause" => KeyCode::KEY_PAUSE,
        "NumLock" => KeyCode::KEY_NUMLOCK,
        "AudioVolumeUp" => KeyCode::KEY_VOLUMEUP,
        "AudioVolumeDown" => KeyCode::KEY_VOLUMEDOWN,
        "AudioVolumeMute" => KeyCode::KEY_MUTE,
        _ if key.chars().count() == 1 => return None,
        _ => return named(&key.to_lowercase()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_lists_and_refuses_the_rest() {
        let c = read_combo("ctrl+shift+Escape").unwrap();
        assert_eq!(c.mods, vec![Modifier::Ctrl, Modifier::Shift]);
        assert_eq!(c.key, Some(Key::Named(KeyCode::KEY_ESC)));
        assert_eq!(read_combo("ctrl++").unwrap().key, Some(Key::Char('+')));
        assert_eq!(read_combo("F24").unwrap().key, Some(Key::Named(KeyCode::KEY_F24)));
        // A keycode, a hex keysym or a modifier after the key is refused, as on the desktop.
        assert!(read_combo("36").is_err());
        assert!(read_combo("0xff0d").is_err());
        assert!(read_combo("Return+shift").is_err());
        assert!(read_combo("F25").is_err());
        assert_eq!(read_combos("ctrl+a Delete").unwrap().len(), 2);
    }
}
