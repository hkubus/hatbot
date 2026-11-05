//! A key, by its Linux input code, on every platform: Windows presses the same physical key by its
//! scan code, which for most keys is the same number.

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct KeyCode(u16);

impl std::fmt::Debug for KeyCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "KeyCode({})", self.0)
    }
}

impl KeyCode {
    pub const KEY_ESC: Self = Self(1);
    pub const KEY_2: Self = Self(3);
    pub const KEY_BACKSPACE: Self = Self(14);
    pub const KEY_TAB: Self = Self(15);
    pub const KEY_ENTER: Self = Self(28);
    pub const KEY_LEFTCTRL: Self = Self(29);
    pub const KEY_A: Self = Self(30);
    pub const KEY_LEFTSHIFT: Self = Self(42);
    pub const KEY_C: Self = Self(46);
    pub const KEY_V: Self = Self(47);
    pub const KEY_LEFTALT: Self = Self(56);
    pub const KEY_SPACE: Self = Self(57);
    pub const KEY_CAPSLOCK: Self = Self(58);
    pub const KEY_F1: Self = Self(59);
    pub const KEY_NUMLOCK: Self = Self(69);
    pub const KEY_SCROLLLOCK: Self = Self(70);
    pub const KEY_F11: Self = Self(87);
    pub const KEY_F12: Self = Self(88);
    pub const KEY_KPENTER: Self = Self(96);
    pub const KEY_RIGHTCTRL: Self = Self(97);
    pub const KEY_KPSLASH: Self = Self(98);
    pub const KEY_SYSRQ: Self = Self(99);
    pub const KEY_RIGHTALT: Self = Self(100);
    pub const KEY_HOME: Self = Self(102);
    pub const KEY_UP: Self = Self(103);
    pub const KEY_PAGEUP: Self = Self(104);
    pub const KEY_LEFT: Self = Self(105);
    pub const KEY_RIGHT: Self = Self(106);
    pub const KEY_END: Self = Self(107);
    pub const KEY_DOWN: Self = Self(108);
    pub const KEY_PAGEDOWN: Self = Self(109);
    pub const KEY_INSERT: Self = Self(110);
    pub const KEY_DELETE: Self = Self(111);
    pub const KEY_MUTE: Self = Self(113);
    pub const KEY_VOLUMEDOWN: Self = Self(114);
    pub const KEY_VOLUMEUP: Self = Self(115);
    pub const KEY_PAUSE: Self = Self(119);
    pub const KEY_LEFTMETA: Self = Self(125);
    pub const KEY_RIGHTMETA: Self = Self(126);
    pub const KEY_COMPOSE: Self = Self(127);
    pub const KEY_F13: Self = Self(183);
    pub const KEY_F24: Self = Self(194);

    pub const fn new(code: u16) -> Self {
        Self(code)
    }

    pub const fn code(self) -> u16 {
        self.0
    }
}

/// How Windows presses a key: by scan code, so the owner's layout decides what it types, or by a
/// virtual key where the scan code is odd (Pause, the media keys, F13 and up).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WinKey {
    Scan { code: u16, extended: bool },
    Virtual(u16),
}

impl KeyCode {
    pub fn windows(self) -> Option<WinKey> {
        let ext = |code| WinKey::Scan { code, extended: true };
        Some(match self.0 {
            69 => WinKey::Virtual(0x90),
            c @ (1..=83 | 86..=88) => WinKey::Scan { code: c, extended: false },
            96 => ext(0x1c),
            97 => ext(0x1d),
            98 => ext(0x35),
            99 => WinKey::Virtual(0x2c),
            100 => ext(0x38),
            102 => ext(0x47),
            103 => ext(0x48),
            104 => ext(0x49),
            105 => ext(0x4b),
            106 => ext(0x4d),
            107 => ext(0x4f),
            108 => ext(0x50),
            109 => ext(0x51),
            110 => ext(0x52),
            111 => ext(0x53),
            113 => WinKey::Virtual(0xad),
            114 => WinKey::Virtual(0xae),
            115 => WinKey::Virtual(0xaf),
            119 => WinKey::Virtual(0x13),
            125 => ext(0x5b),
            126 => ext(0x5c),
            127 => ext(0x5d),
            c @ 183..=194 => WinKey::Virtual(0x7c + c - 183),
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_presses_the_same_physical_keys() {
        assert_eq!(KeyCode::KEY_A.windows(), Some(WinKey::Scan { code: 0x1e, extended: false }));
        assert_eq!(KeyCode::KEY_UP.windows(), Some(WinKey::Scan { code: 0x48, extended: true }));
        assert_eq!(KeyCode::KEY_RIGHTALT.windows(), Some(WinKey::Scan { code: 0x38, extended: true }));
        assert_eq!(KeyCode::KEY_NUMLOCK.windows(), Some(WinKey::Virtual(0x90)));
        assert_eq!(KeyCode::KEY_F13.windows(), Some(WinKey::Virtual(0x7c)));
        assert_eq!(KeyCode::KEY_F24.windows(), Some(WinKey::Virtual(0x87)));
        assert_eq!(KeyCode::new(240).windows(), None);
    }
}
