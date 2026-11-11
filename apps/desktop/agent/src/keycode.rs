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

impl KeyCode {
    /// The Mac's virtual key code for the same physical key (Carbon's kVK_*): Command is the Meta key,
    /// Option the Alt key.
    pub fn mac(self) -> Option<u16> {
        const MAIN: [u16; 58] = [
            0x35, 0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1a, 0x1c, 0x19, 0x1d, 0x1b, 0x18, 0x33, 0x30, 0x0c, 0x0d, 0x0e,
            0x0f, 0x11, 0x10, 0x20, 0x22, 0x1f, 0x23, 0x21, 0x1e, 0x24, 0x3b, 0x00, 0x01, 0x02, 0x03, 0x05, 0x04, 0x26,
            0x28, 0x25, 0x29, 0x27, 0x32, 0x38, 0x2a, 0x06, 0x07, 0x08, 0x09, 0x0b, 0x2d, 0x2e, 0x2b, 0x2f, 0x2c, 0x3c,
            0x43, 0x3a, 0x31, 0x39,
        ];
        const F1_TO_F10: [u16; 10] = [0x7a, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6d];
        const KEYPAD: [u16; 13] = [0x59, 0x5b, 0x5c, 0x4e, 0x56, 0x57, 0x58, 0x45, 0x53, 0x54, 0x55, 0x52, 0x41];
        const F13_TO_F20: [u16; 8] = [0x69, 0x6b, 0x71, 0x6a, 0x40, 0x4f, 0x50, 0x5a];
        Some(match self.0 {
            c @ 1..=58 => MAIN[c as usize - 1],
            c @ 59..=68 => F1_TO_F10[c as usize - 59],
            69 => 0x47,
            c @ 71..=83 => KEYPAD[c as usize - 71],
            86 => 0x0a,
            87 => 0x67,
            88 => 0x6f,
            96 => 0x4c,
            97 => 0x3e,
            98 => 0x4b,
            100 => 0x3d,
            102 => 0x73,
            103 => 0x7e,
            104 => 0x74,
            105 => 0x7b,
            106 => 0x7c,
            107 => 0x77,
            108 => 0x7d,
            109 => 0x79,
            110 => 0x72,
            111 => 0x75,
            113 => 0x4a,
            114 => 0x49,
            115 => 0x48,
            117 => 0x51,
            125 => 0x37,
            126 => 0x36,
            127 => 0x6e,
            c @ 183..=190 => F13_TO_F20[c as usize - 183],
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mac_presses_the_same_physical_keys() {
        assert_eq!(KeyCode::KEY_A.mac(), Some(0x00));
        assert_eq!(KeyCode::KEY_V.mac(), Some(0x09));
        assert_eq!(KeyCode::KEY_ENTER.mac(), Some(0x24));
        assert_eq!(KeyCode::KEY_SPACE.mac(), Some(0x31));
        assert_eq!(KeyCode::KEY_LEFTMETA.mac(), Some(0x37));
        assert_eq!(KeyCode::KEY_RIGHTALT.mac(), Some(0x3d));
        assert_eq!(KeyCode::KEY_F12.mac(), Some(0x6f));
        assert_eq!(KeyCode::KEY_DOWN.mac(), Some(0x7d));
        assert_eq!(KeyCode::new(80).mac(), Some(0x54));
        assert_eq!(KeyCode::KEY_SYSRQ.mac(), None);
        assert_eq!(KeyCode::KEY_F24.mac(), None);
    }

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
